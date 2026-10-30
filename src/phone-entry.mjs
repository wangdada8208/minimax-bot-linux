import { readFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { startMobileBridge } from './mobile-bridge.mjs';
const token = readFileSync('/data/.minimax-bot/access-token', 'utf8').trim();
const bridge = await startMobileBridge({ host: '100.89.234.21', port: 8792, token, notifyStorePath: '/data/.minimax-bot/phone-notifications.json' });
const server = createServer((req, res) => {
  const upstream = request({hostname:'127.0.0.1',port:bridge.port,path:req.url,method:req.method,headers:req.headers}, up => {
    res.writeHead(up.statusCode || 502, up.headers); up.pipe(res);
  });
  upstream.on('error', () => {if (!res.headersSent) res.writeHead(502);res.end();});
  req.pipe(upstream);
});
server.on('upgrade', (req, socket, head) => {
  const upstream = connect(bridge.port, '127.0.0.1', () => {
    let text = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (const [key,value] of Object.entries(req.headers)) for (const item of Array.isArray(value)?value:[value]) text += `${key}: ${item}\r\n`;
    upstream.write(text+'\r\n');if(head.length) upstream.write(head);
    socket.pipe(upstream);upstream.pipe(socket);
  });
  upstream.on('error',()=>socket.destroy());socket.on('error',()=>upstream.destroy());
  socket.on('close',()=>upstream.destroy());upstream.on('close',()=>socket.destroy());
});
server.listen(8794,'100.89.234.21',()=>console.log('Phone entry listening on 8794'));
