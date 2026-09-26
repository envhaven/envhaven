package main

// Live host-resource, tmux-window, and preview-port snapshots for Cockpit.

import (
	"bufio"
	"context"
	"io"
	"math"
	"net"
	"net/http"
	"os"
	"runtime"
	"strconv"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

type cpuStats struct {
	Pct   float64 `json:"pct"`
	NCpus int     `json:"nCpus"`
}

type ramStats struct {
	UsedMb  int     `json:"usedMb"`
	TotalMb int     `json:"totalMb"`
	Pct     float64 `json:"pct"`
}

type diskStats struct {
	UsedGb  float64 `json:"usedGb"`
	TotalGb float64 `json:"totalGb"`
	Pct     float64 `json:"pct"`
}

type window struct {
	Index  int    `json:"index"`
	Name   string `json:"name"`
	Active bool   `json:"active"`
}

type previewStats struct {
	PortOpen bool `json:"portOpen"`
	Port     int  `json:"port"`
}

type statsResponse struct {
	CPU        cpuStats     `json:"cpu"`
	RAM        ramStats     `json:"ram"`
	Disk       diskStats    `json:"disk"`
	Windows    []window     `json:"windows"`
	Preview    previewStats `json:"preview"`
	CapturedAt int64        `json:"capturedAt"`
}

func handleStats(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeAPIError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	writeJSON(w, http.StatusOK, statsResponse{
		CPU:        cpuStats{Pct: cpuPercent(), NCpus: runtime.NumCPU()},
		RAM:        ramSnapshot(),
		Disk:       diskSnapshot(),
		Windows:    listWindows(r.Context()),
		Preview:    previewSnapshot(),
		CapturedAt: time.Now().UnixMilli(),
	})
}

// cpuPercent samples aggregate /proc/stat jiffies twice and returns busy%.
func cpuPercent() float64 {
	idle1, total1, ok1 := readCPUSample()
	if !ok1 {
		return 0
	}
	time.Sleep(100 * time.Millisecond)
	idle2, total2, ok2 := readCPUSample()
	if !ok2 || total2 <= total1 {
		return 0
	}
	if idle2 < idle1 {
		idle2 = idle1
	}
	pct := 100 * (1 - float64(idle2-idle1)/float64(total2-total1))
	return math.Max(0, math.Min(100, pct))
}

func readCPUSample() (idle, total uint64, ok bool) {
	data, err := os.ReadFile("/proc/stat")
	if err != nil {
		return 0, 0, false
	}
	return parseCPUSample(string(data))
}

// parseCPUSample sums user through steal (fields 1 through 8).
func parseCPUSample(data string) (idle, total uint64, ok bool) {
	line := data
	if i := strings.IndexByte(line, '\n'); i >= 0 {
		line = line[:i]
	}
	fields := strings.Fields(line)
	if len(fields) < 9 || fields[0] != "cpu" {
		return 0, 0, false
	}
	for i := 1; i <= 8; i++ {
		v, err := strconv.ParseUint(fields[i], 10, 64)
		if err != nil {
			return 0, 0, false
		}
		total += v
	}
	idle, _ = strconv.ParseUint(fields[4], 10, 64)
	return idle, total, true
}

func ramSnapshot() ramStats {
	totalKb, availKb := readMemInfo()
	if totalKb == 0 {
		return ramStats{}
	}
	if availKb > totalKb {
		availKb = totalKb
	}
	usedKb := totalKb - availKb
	return ramStats{
		UsedMb:  int(math.Round(float64(usedKb) / 1024)),
		TotalMb: int(math.Round(float64(totalKb) / 1024)),
		Pct:     float64(usedKb) / float64(totalKb) * 100,
	}
}

func readMemInfo() (totalKb, availKb uint64) {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0, 0
	}
	defer f.Close()
	return parseMemInfo(f)
}

func parseMemInfo(r io.Reader) (totalKb, availKb uint64) {
	s := bufio.NewScanner(r)
	for s.Scan() {
		fields := strings.Fields(s.Text())
		if len(fields) < 2 {
			continue
		}
		switch fields[0] {
		case "MemTotal:":
			totalKb, _ = strconv.ParseUint(fields[1], 10, 64)
		case "MemAvailable:":
			availKb, _ = strconv.ParseUint(fields[1], 10, 64)
		}
	}
	return totalKb, availKb
}

// diskSnapshot reports what the workspace user can see and fill from one statfs of /.
func diskSnapshot() diskStats {
	var st unix.Statfs_t
	if err := unix.Statfs("/", &st); err != nil || st.Bsize <= 0 {
		return diskStats{}
	}
	return diskFrom(st.Blocks, st.Bfree, st.Bavail, uint64(st.Bsize))
}

// diskFrom uses written blocks as usage and unprivileged reachable blocks as
// capacity. This matches df and excludes tune2fs' per-tier reserve.
func diskFrom(blocks, bfree, bavail, bsize uint64) diskStats {
	if blocks < bfree || bfree < bavail {
		return diskStats{}
	}
	used := (blocks - bfree) * bsize
	capacity := used + bavail*bsize
	if capacity == 0 {
		return diskStats{}
	}
	const gb = float64(1 << 30)
	return diskStats{
		UsedGb:  math.Round(float64(used)/gb*10) / 10,
		TotalGb: math.Round(float64(capacity)/gb*10) / 10,
		Pct:     float64(used) / float64(capacity) * 100,
	}
}

func listWindows(ctx context.Context) []window {
	out, err := tmuxOutput(ctx, "list-windows", "-t", sessionTarget(tmuxSession), "-F", "#{window_index}|#{window_active}|#{window_name}")
	if err != nil {
		return []window{}
	}
	return parseWindows(out)
}

func parseWindows(out string) []window {
	ws := []window{}
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "|", 3)
		if len(parts) != 3 {
			continue
		}
		idx, err := strconv.Atoi(parts[0])
		if err != nil {
			continue
		}
		ws = append(ws, window{Index: idx, Name: parts[2], Active: parts[1] == "1"})
	}
	return ws
}

func previewSnapshot() previewStats {
	port := 3000
	if v := os.Getenv("ENVHAVEN_EXPOSED_PORT"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 65535 {
			port = n
		}
	}
	return previewStats{PortOpen: tcpOpen(port), Port: port}
}

func tcpOpen(port int) bool {
	conn, err := net.DialTimeout("tcp", "127.0.0.1:"+strconv.Itoa(port), 500*time.Millisecond)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}
