const fs = require('fs');
const BASE = '/Users/jasonchen/Downloads/Panel-Omen-main 2/minecraft-server';
process.chdir(BASE);
const { io } = require('socket.io-client');

const uuid = '3a9614ee46124946801fae8bd9e8f99e';
const key = JSON.parse(fs.readFileSync(BASE + '/mcsmanager/daemon/data/Config/global.json', 'utf8')).key;

const socket = io('http://127.0.0.1:24444', {
  path: '/socket.io', reconnection: false, timeout: 10000, transports: ['websocket']
});

const timer = setTimeout(() => { console.log('--- 25s elapsed, exiting listener ---'); process.exit(0); }, 25000);

socket.on('connect', () => { console.log('connected'); socket.emit('auth', { uuid: null, data: key }); });
socket.on('auth', (p) => {
  console.log('auth:', JSON.stringify(p));
  if (p && p.data === true) {
    socket.emit('instance/open', { uuid: null, data: { instanceUuids: [uuid], instanceUuid: uuid } });
  }
});
socket.on('instance/open', (p) => console.log('instance/open reply:', JSON.stringify(p).slice(0, 500)));
socket.on('instance/started', (p) => console.log('STARTED:', JSON.stringify(p).slice(0, 300)));
socket.on('instance/stopped', (p) => console.log('STOPPED:', JSON.stringify(p).slice(0, 300)));
socket.on('instance/console', (p) => {
  if (p && p.data && p.data.instanceUuid === uuid) {
    process.stdout.write(String(p.data.text || ''));
  }
});
socket.onAny((ev) => {
  if (!['auth', 'instance/started', 'instance/open', 'instance/console', 'instance/stopped'].includes(ev)) {
    console.log('  event:', ev);
  }
});
socket.on('connect_error', (e) => { console.log('connect_error:', e.message); clearTimeout(timer); process.exit(1); });
