#!/usr/bin/env python3
"""TCP latency proxy for predictive-echo e2e.

Forwards 127.0.0.1:LISTEN -> TARGET, delaying each direction by a fixed
per-chunk latency while preserving chunk order and relative gaps (a queue per
direction; never reorders, never coalesces). Usage:

  latency-proxy.py LISTEN_PORT TARGET_HOST TARGET_PORT DOWN_MS UP_MS [BIND_HOST [OWNER_ID]]

BIND_HOST defaults to 127.0.0.1; the console harness passes 0.0.0.0 when it runs
the proxy INSIDE a managed container (whose console binds loopback, so the delay
line has to live on the container's bridge interface to be reached at all).
OWNER_ID is an inert process-ownership marker used only for safe cleanup.
"""
import asyncio
import os
import sys

# Checked rather than unpacked. Run it wrong and the bare tuple form raised IndexError
# with a traceback and no usage line, and the rig pipes this stderr into its startup
# failure, so a good message here is the one the operator actually sees.
if len(sys.argv) not in (6, 7, 8):
    sys.exit(__doc__)
try:
    LISTEN, THOST, TPORT, DOWN, UP = (
        int(sys.argv[1]), sys.argv[2], int(sys.argv[3]), int(sys.argv[4]) / 1000, int(sys.argv[5]) / 1000)
    BIND = sys.argv[6] if len(sys.argv) >= 7 else '127.0.0.1'
except ValueError as e:
    sys.exit(f'latency-proxy: {e}\n{__doc__}')


async def pump(reader, writer, delay):
    # Unbounded on purpose. This is a pure delay line: a bounded queue would apply
    # backpressure and make it a delay-plus-congestion simulator, retuning the timing
    # every check in the suite was measured against. A terminal at a few KB/s against a
    # sub-100ms delay keeps a few hundred bytes in flight.
    q = asyncio.Queue()

    async def drain():
        while True:
            t, chunk = await q.get()
            if chunk is None:
                break
            now = asyncio.get_event_loop().time()
            if t + delay > now:
                await asyncio.sleep(t + delay - now)
            try:
                writer.write(chunk)
                await writer.drain()
            except Exception:
                break
        try:
            writer.close()
        except Exception:
            pass

    d = asyncio.create_task(drain())
    try:
        while True:
            chunk = await reader.read(65536)
            if not chunk:
                break
            await q.put((asyncio.get_event_loop().time(), chunk))
    except Exception:
        pass
    await q.put((0, None))
    await d


async def handle(cr, cw):
    try:
        sr, sw = await asyncio.open_connection(THOST, TPORT)
    except Exception:
        cw.close()
        return
    await asyncio.gather(pump(cr, sw, UP), pump(sr, cw, DOWN))


async def main():
    server = await asyncio.start_server(handle, BIND, LISTEN)
    port = server.sockets[0].getsockname()[1]
    ready_file = os.environ.get('ENVHAVEN_LATENCY_PROXY_READY_FILE')
    if ready_file:
        pending_file = ready_file + '.tmp'
        with open(pending_file, 'w', encoding='ascii') as ready:
            ready.write(str(port))
        os.replace(pending_file, ready_file)
    print(f'latency-proxy on {BIND}:{port} -> {THOST}:{TPORT} down={DOWN*1000:.0f}ms up={UP*1000:.0f}ms', flush=True)
    async with server:
        await server.serve_forever()

asyncio.run(main())
