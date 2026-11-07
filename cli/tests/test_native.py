"""Native transport protocol regressions over real loopback sockets."""
import asyncio
import base64
import hashlib
import unittest
from unittest.mock import patch

from mioa_core.native import _WebSocket


class NativeTransportTest(unittest.IsolatedAsyncioTestCase):
    async def test_upgrade_preserves_case_sensitive_accept_and_token_case(self):
        payload = b'{"id":7,"result":{"value":"MiXeD"}}'
        completed = asyncio.get_running_loop().create_future()

        async def peer(reader, writer):
            try:
                request = await reader.readuntil(b"\r\n\r\n")
                headers = dict(line.split(b":",1) for line in request.split(b"\r\n")[1:] if b":" in line)
                key = headers[b"Sec-WebSocket-Key"].strip()
                accept = base64.b64encode(hashlib.sha1(key+b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest())
                self.assertEqual(accept,b"s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")
                writer.write(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: WebSocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: "+accept+b"\r\n\r\n"+bytes((0x81,len(payload)))+payload)
                await writer.drain()
                await reader.read()
                completed.set_result(None)
            except BaseException as exc:
                if not completed.done():
                    completed.set_exception(exc)
            finally:
                writer.close()
                await writer.wait_closed()

        server = await asyncio.start_server(peer,"127.0.0.1",0)
        socket = None
        try:
            with patch("mioa_core.native.secrets.token_bytes",return_value=b"the sample nonce"):
                socket = await _WebSocket.connect(f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}/devtools/browser")
            self.assertEqual(await asyncio.wait_for(socket.receive(),2),payload)
        finally:
            if socket:
                await socket.close()
            server.close()
            await server.wait_closed()
            await asyncio.wait_for(completed,2)
