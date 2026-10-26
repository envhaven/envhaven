import React, { useEffect, useCallback, useRef } from 'react';
import { Box, useApp, useInput, useStdout } from 'ink';
import { useAtom, useSetAtom, useAtomValue } from 'jotai';
import { Header } from './components/Header';
import { Menu } from './components/Menu';
import { Output } from './components/Output';
import { StatusBar } from './components/StatusBar';
import { HelpModal } from './components/HelpModal';
import { TestSubmenu } from './components/TestSubmenu';
import { StartSubmenu } from './components/StartSubmenu';
import { SettingsEditor } from './components/SettingsEditor';
import {
  selectedIndexAtom,
  submenuIndexAtom,
  settingsIndexAtom,
  outputLinesAtom,
  containerStatusAtom,
  containerStaleAtom,
  configAtom,
  uiModeAtom,
  terminalSizeAtom,
  progressAtom,
  abortControllerAtom,
  uiModeTypeAtom,
  isHelpAtom,
  isSubmenuAtom,
  isSettingsAtom,
  isReleaseAtom,
  MENU_ITEMS,
  TEST_SUBMENU,
  START_SUBMENU,
  SETTINGS_FIELDS,
  createLogLine,
  type LogLine,
} from './state/atoms';
import { loadConfig } from './lib/config';
import { getContainerStatus, isContainerImageStale } from './lib/docker';
import { runBuild } from './actions/build';
import { runContainer } from './actions/run';
import { deleteContainer } from './actions/delete';
import { runWatch } from './actions/watch';
import { runTestImage, runTestCli, runTestExtension, runTestAiTools } from './actions/test';
import { runLogs } from './actions/logs';
import { runShell } from './actions/shell';
import { runRelease } from './actions/release';
import { ReleasePrompt } from './components/ReleasePrompt';

const LOG_BATCH_INTERVAL_NORMAL = 50;
const LOG_BATCH_INTERVAL_BURST = 150;
const BURST_THRESHOLD = 20;
const MAX_LOG_LINES = 500;
const RESIZE_DEBOUNCE_MS = 100;

const OPERATION_NAMES: Record<string, string> = {
  'start-normal': 'Starting...',
  'start-recreate': 'Recreating...',
  'start-delete': 'Deleting...',
  build: 'Building...',
  watch: 'Watching...',
  'test-image': 'Testing Image...',
  'test-ai': 'Testing AI Tools...',
  'test-cli': 'Testing CLI...',
  'test-ext': 'Testing Extension...',
  logs: 'Streaming Logs...',
  release: 'Releasing...',
};

export function App() {
  const { exit } = useApp();
  const { stdout } = useStdout();

  const [selectedIndex, setSelectedIndex] = useAtom(selectedIndexAtom);
  const [submenuIndex, setSubmenuIndex] = useAtom(submenuIndexAtom);
  const setSettingsIndex = useSetAtom(settingsIndexAtom);
  const [uiMode, setUIMode] = useAtom(uiModeAtom);
  const setOutputLines = useSetAtom(outputLinesAtom);
  const setContainerStatus = useSetAtom(containerStatusAtom);
  const setContainerStale = useSetAtom(containerStaleAtom);
  const setConfig = useSetAtom(configAtom);
  const setTerminalSize = useSetAtom(terminalSizeAtom);
  const setProgress = useSetAtom(progressAtom);
  const [abortController, setAbortController] = useAtom(abortControllerAtom);
  const config = useAtomValue(configAtom);
  const terminalSize = useAtomValue(terminalSizeAtom);
  
  const uiModeType = useAtomValue(uiModeTypeAtom);
  const showHelp = useAtomValue(isHelpAtom);
  const activeSubmenu = useAtomValue(isSubmenuAtom);
  const showSettings = useAtomValue(isSettingsAtom);
  const showRelease = useAtomValue(isReleaseAtom);

  const currentProcessRef = useRef<{ kill: () => void } | null>(null);
  const pendingLogsRef = useRef<LogLine[]>([]);
  const batchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastFlushTimeRef = useRef<number>(0);
  const recentLogCountRef = useRef<number>(0);

  const flushLogs = useCallback(() => {
    if (batchTimeoutRef.current) {
      clearTimeout(batchTimeoutRef.current);
      batchTimeoutRef.current = null;
    }

    const logsToAdd = pendingLogsRef.current;
    const count = logsToAdd.length;
    if (count === 0) return;

    pendingLogsRef.current = [];
    
    const now = Date.now();
    if (now - lastFlushTimeRef.current < 200) {
      recentLogCountRef.current += count;
    } else {
      recentLogCountRef.current = count;
    }
    lastFlushTimeRef.current = now;

    setOutputLines((prev) => {
      const prevLen = prev.length;
      const newLen = prevLen + count;
      
      if (newLen <= MAX_LOG_LINES) {
        const result = new Array(newLen);
        for (let i = 0; i < prevLen; i++) result[i] = prev[i];
        for (let i = 0; i < count; i++) result[prevLen + i] = logsToAdd[i];
        return result;
      }
      
      const keepFromPrev = MAX_LOG_LINES - count;
      if (keepFromPrev <= 0) return logsToAdd.slice(-MAX_LOG_LINES);
      
      const startIdx = prevLen - keepFromPrev;
      const result = new Array(MAX_LOG_LINES);
      for (let i = 0; i < keepFromPrev; i++) result[i] = prev[startIdx + i];
      for (let i = 0; i < count; i++) result[keepFromPrev + i] = logsToAdd[i];
      return result;
    });
  }, [setOutputLines]);

  const addLog = useCallback(
    (type: Parameters<typeof createLogLine>[0], text: string) => {
      pendingLogsRef.current.push(createLogLine(type, text));

      if (!batchTimeoutRef.current) {
        const interval = recentLogCountRef.current > BURST_THRESHOLD 
          ? LOG_BATCH_INTERVAL_BURST 
          : LOG_BATCH_INTERVAL_NORMAL;
        batchTimeoutRef.current = setTimeout(flushLogs, interval);
      }
    },
    [flushLogs]
  );

  const clearLogs = useCallback(() => {
    pendingLogsRef.current = [];
    recentLogCountRef.current = 0;
    if (batchTimeoutRef.current) {
      clearTimeout(batchTimeoutRef.current);
      batchTimeoutRef.current = null;
    }
    setOutputLines([]);
    setProgress(null);
  }, [setOutputLines, setProgress]);

  const refreshStatus = useCallback(async () => {
    if (!config) return;
    const [status, stale] = await Promise.all([
      getContainerStatus(config.containerName),
      isContainerImageStale(config.containerName, config.image),
    ]);
    setContainerStatus(status);
    setContainerStale(stale);
  }, [config, setContainerStatus, setContainerStale]);

  useEffect(() => {
    const cfg = loadConfig();
    setConfig(cfg);
    Promise.all([
      getContainerStatus(cfg.containerName),
      isContainerImageStale(cfg.containerName, cfg.image),
    ]).then(([status, stale]) => {
      setContainerStatus(status);
      setContainerStale(stale);
    });
  }, [setConfig, setContainerStatus, setContainerStale]);

  useEffect(() => {
    if (!config || uiModeType !== 'idle') return;

    const interval = setInterval(() => {
      Promise.all([
        getContainerStatus(config.containerName),
        isContainerImageStale(config.containerName, config.image),
      ]).then(([status, stale]) => {
        setContainerStatus(status);
        setContainerStale(stale);
      });
    }, 5000);

    return () => clearInterval(interval);
  }, [config, uiModeType, setContainerStatus, setContainerStale]);

  useEffect(() => {
    let resizeTimeout: ReturnType<typeof setTimeout> | null = null;
    let lastWidth = stdout?.columns ?? 80;
    let lastHeight = stdout?.rows ?? 24;

    setTerminalSize({ width: lastWidth, height: lastHeight });

    const handleResize = () => {
      if (resizeTimeout) clearTimeout(resizeTimeout);

      resizeTimeout = setTimeout(() => {
        const newWidth = stdout?.columns ?? 80;
        const newHeight = stdout?.rows ?? 24;

        if (newWidth !== lastWidth || newHeight !== lastHeight) {
          lastWidth = newWidth;
          lastHeight = newHeight;
          setTerminalSize({ width: newWidth, height: newHeight });
        }
      }, RESIZE_DEBOUNCE_MS);
    };

    stdout?.on('resize', handleResize);
    return () => {
      stdout?.off('resize', handleResize);
      if (resizeTimeout) clearTimeout(resizeTimeout);
    };
  }, [stdout, setTerminalSize]);

  useEffect(() => {
    return () => {
      if (batchTimeoutRef.current) clearTimeout(batchTimeoutRef.current);
    };
  }, []);

  const executeAction = useCallback(
    async (actionKey: string) => {
      if (!config) return;

      if (actionKey === 'test') {
        setUIMode({ type: 'submenu', menu: 'test' });
        setSubmenuIndex(0);
        return;
      }

      if (actionKey === 'start') {
        setUIMode({ type: 'submenu', menu: 'start' });
        setSubmenuIndex(0);
        return;
      }

      if (actionKey === 'settings') {
        setUIMode({ type: 'settings' });
        setSettingsIndex(0);
        clearLogs();
        return;
      }

      if (actionKey === 'release') {
        setUIMode({ type: 'release' });
        clearLogs();
        return;
      }

      if (actionKey === 'shell') {
        setUIMode({ type: 'running', operation: 'Shell' });
        addLog('info', 'Opening shell...');
        await runShell(config, exit);
        return;
      }

      setUIMode({ type: 'running', operation: OPERATION_NAMES[actionKey] || 'Running...' });
      clearLogs();

      const controller = new AbortController();
      setAbortController(controller);
      const signal = controller.signal;

      try {
        switch (actionKey) {
          case 'build':
            await runBuild(config, addLog, (proc) => { currentProcessRef.current = proc; }, setProgress, false, signal);
            break;
          case 'start-normal':
            await runContainer(addLog, refreshStatus);
            break;
          case 'start-recreate':
            await deleteContainer(config, addLog, refreshStatus);
            await runContainer(addLog, refreshStatus);
            break;
          case 'start-delete':
            await deleteContainer(config, addLog, refreshStatus);
            break;
          case 'watch':
            await runWatch(config, addLog, refreshStatus, (proc) => { currentProcessRef.current = proc; }, signal);
            break;
          case 'test-image':
            await runTestImage(config, addLog, (proc) => { currentProcessRef.current = proc; }, signal);
            break;
          case 'test-ai':
            await runTestAiTools(config, addLog, (proc) => { currentProcessRef.current = proc; }, signal);
            break;
          case 'test-cli':
            await runTestCli(config, addLog, (proc) => { currentProcessRef.current = proc; }, signal);
            break;
          case 'test-ext':
            await runTestExtension(config, addLog, (proc) => { currentProcessRef.current = proc; }, signal);
            break;
          case 'logs':
            await runLogs(config, addLog, (proc) => { currentProcessRef.current = proc; }, signal);
            break;
        }
      } catch (err) {
        if (!signal.aborted) {
          addLog('error', `Error: ${err instanceof Error ? err.message : String(err)}`);
        }
      } finally {
        flushLogs();
        setUIMode({ type: 'idle' });
        setAbortController(null);
        currentProcessRef.current = null;
        await refreshStatus();
      }
    },
    [config, addLog, flushLogs, clearLogs, setUIMode, refreshStatus, exit, setSubmenuIndex, setSettingsIndex, setAbortController, setProgress]
  );

  const cancelOperation = useCallback(() => {
    abortController?.abort();
    currentProcessRef.current?.kill();
    flushLogs();
    addLog('warn', 'Operation cancelled');
    setUIMode({ type: 'idle' });
    setAbortController(null);
    currentProcessRef.current = null;
  }, [addLog, flushLogs, setUIMode, abortController, setAbortController]);

  const executeRelease = useCallback(
    async (version: string) => {
      setUIMode({ type: 'running', operation: 'Releasing...' });
      clearLogs();

      const controller = new AbortController();
      setAbortController(controller);

      try {
        await runRelease(version, addLog, (proc) => { currentProcessRef.current = proc; }, controller.signal);
      } catch (err) {
        if (!controller.signal.aborted) {
          addLog('error', `Error: ${err instanceof Error ? err.message : String(err)}`);
        }
      } finally {
        flushLogs();
        setUIMode({ type: 'idle' });
        setAbortController(null);
        currentProcessRef.current = null;
      }
    },
    [addLog, flushLogs, clearLogs, setUIMode, setAbortController]
  );

  useInput((input, key) => {
    const mode = uiMode.type;

    if (key.escape) {
      if (mode === 'running') cancelOperation();
      else if (mode !== 'idle') setUIMode({ type: 'idle' });
      return;
    }

    if (input === '?' && mode !== 'running') {
      setUIMode(mode === 'help' ? { type: 'idle' } : { type: 'help' });
      return;
    }

    if (input === 'q' && mode === 'idle') {
      exit();
      return;
    }

    if (key.ctrl && input === 'c') {
      if (mode === 'running') cancelOperation();
      else exit();
      return;
    }

    if (mode === 'idle') {
      if (key.upArrow) {
        setSelectedIndex((prev) => (prev > 0 ? prev - 1 : MENU_ITEMS.length - 1));
        return;
      }
      if (key.downArrow) {
        setSelectedIndex((prev) => (prev < MENU_ITEMS.length - 1 ? prev + 1 : 0));
        return;
      }
      if (key.return) {
        const item = MENU_ITEMS[selectedIndex];
        if (item) executeAction(item.key);
        return;
      }

      const item = MENU_ITEMS.find((m) => m.shortcut === input);
      if (item) {
        setSelectedIndex(MENU_ITEMS.indexOf(item));
        executeAction(item.key);
      }
      return;
    }

    if (mode === 'submenu') {
      const currentMenu = uiMode.type === 'submenu' ? uiMode.menu : null;
      const submenuItems = currentMenu === 'start' ? START_SUBMENU : TEST_SUBMENU;

      if (key.upArrow) {
        setSubmenuIndex((prev) => (prev > 0 ? prev - 1 : submenuItems.length - 1));
        return;
      }
      if (key.downArrow) {
        setSubmenuIndex((prev) => (prev < submenuItems.length - 1 ? prev + 1 : 0));
        return;
      }
      if (key.return) {
        const item = submenuItems[submenuIndex];
        if (item) {
          setUIMode({ type: 'idle' });
          executeAction(item.key);
        }
        return;
      }

      const item = submenuItems.find((m) => m.shortcut === input);
      if (item) {
        setUIMode({ type: 'idle' });
        executeAction(item.key);
      }
      return;
    }

    if (mode === 'settings') {
      if (key.upArrow) {
        setSettingsIndex((prev) => (prev > 0 ? prev - 1 : SETTINGS_FIELDS.length - 1));
        return;
      }
      if (key.downArrow) {
        setSettingsIndex((prev) => (prev < SETTINGS_FIELDS.length - 1 ? prev + 1 : 0));
        return;
      }
    }
  });

  const contentHeight = Math.max(1, terminalSize.height - 6);
  const showTestSubmenu = activeSubmenu === 'test';
  const showStartSubmenu = activeSubmenu === 'start';

  const renderContent = () => {
    if (showTestSubmenu) return <TestSubmenu />;
    if (showStartSubmenu) return <StartSubmenu />;
    if (showSettings) return <SettingsEditor />;
    if (showRelease) return (
      <ReleasePrompt
        onSubmit={executeRelease}
        onCancel={() => setUIMode({ type: 'idle' })}
      />
    );
    return <Output />;
  };

  return (
    <Box
      flexDirection="column"
      width={terminalSize.width}
      height={terminalSize.height}
      overflow="hidden"
    >
      <Header />

      <Box flexDirection="row" height={contentHeight} flexShrink={0} overflow="hidden">
        <Box width={28} flexShrink={0}>
          <Menu />
        </Box>

        <Box flexGrow={1} flexDirection="column" overflow="hidden">
          {renderContent()}
        </Box>
      </Box>

      <StatusBar />

      {showHelp && <HelpModal width={terminalSize.width} height={terminalSize.height} />}
    </Box>
  );
}
