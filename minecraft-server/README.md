# Minecraft Server - PumpkinMC + MCSManager on Replit

A lightweight Minecraft hosting proof-of-concept running PumpkinMC (Rust-based server) with MCSManager (web management panel) on Replit.

## Architecture

```
Replit (Local)
├── PumpkinMC Server    (port 25565)
├── MCSManager Web      (port 23333)
├── MCSManager Daemon   (port 24444)
└── Custom API          (port 3001)
```

All services run locally. No external tunnels or public access configured.

## Components

| Component | Description | Port |
|-----------|-------------|------|
| **PumpkinMC** | Rust-based Minecraft server (no Java required) | 25565 |
| **MCSManager Web** | Web management panel | 23333 |
| **MCSManager Daemon** | Server process manager | 24444 |
| **Custom API** | Plugin system for server control | 3001 |
| **Node.js v20.11** | Runtime for MCSManager and API | - |

## Quick Start

### Start Everything

```bash
cd minecraft-server
bash scripts/supervisor.sh
```

### Individual Services

```bash
bash scripts/start-pumpkin.sh    # Start Minecraft server only
bash scripts/start-mcsm.sh       # Start MCSManager only
```

### Control Scripts

```bash
bash scripts/supervisor.sh       # Start all services (recommended)
bash scripts/stop.sh             # Stop all services
bash scripts/restart.sh          # Restart all services
bash scripts/status.sh           # Check service status
```

## Accessing Services

| Service | URL |
|---------|-----|
| MCSManager | `http://localhost:23333` |
| Custom API | `http://localhost:3001` |
| PumpkinMC | `localhost:25565` (Minecraft client) |

### MCSManager Setup

1. Start services: `bash scripts/start.sh`
2. Open the Replit web preview or visit `http://localhost:23333`
3. Complete the initial setup wizard
4. Create an account (first account becomes admin)
5. Add a new instance pointing to the PumpkinMC server

### Configuring MCSManager for PumpkinMC

In the MCSManager web panel:
1. Go to **Instances** > **Create New Instance**
2. Set the **Server Directory** to: `/home/runner/workspace/minecraft-server/pumpkin-server`
3. Set the **Startup Command** to: `./pumpkin`
4. Set **Node** to the local daemon
5. Save and start the instance

## Custom API & Plugin System

A REST API runs on port 3001 for controlling Minecraft servers programmatically.

### API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/plugins` | List loaded plugins |
| GET | `/api/servers` | List servers |
| POST | `/api/servers` | Create a server |
| POST | `/api/servers/:id/start` | Start a server |
| POST | `/api/servers/:id/stop` | Stop a server |
| GET | `/api/servers/:id/console` | Read server console |
| GET | `/api/servers/:id/files` | List server files |
| GET | `/api/permissions` | List user permissions |

### Writing a Plugin

Plugins go in the `plugins/` directory. Each plugin extends the `Plugin` class:

```javascript
const { Plugin } = require('../api/plugin-interface');

class MyPlugin extends Plugin {
  async init() {
    this.api.registerPlugin('myPlugin', this);
  }

  // Add your methods here
  async doSomething() {
    return { result: 'done' };
  }
}

module.exports = MyPlugin;
```

### Available Plugin Interfaces

- **ServerManager** - Create, start, stop, list servers
- **ConsoleReader** - Read server console output
- **FileManager** - List and read server files
- **PermissionManager** - Manage user permissions

See `api/plugin-interface.js` for full interface definitions.

## Configuration Files

| File | Purpose |
|------|---------|
| `pumpkin-server/pumpkin.toml` | PumpkinMC server configuration |
| `pumpkin-server/eula.txt` | EULA acceptance |
| `mcsm.env` | MCSManager environment settings |
| `api/index.js` | Custom API server |
| `api/plugin-interface.js` | Plugin interface definitions |
| `api/plugin-loader.js` | Plugin loader |

## Resource Usage

This setup is optimized for Replit's resource constraints:

- **PumpkinMC**: View distance 6, simulation distance 4, max 20 players
- **MCSManager**: Node.js limited to 2048MB heap
- **Bedrock Edition**: Disabled to save resources
- **World autosave**: Every 6000 ticks (5 minutes)

## Troubleshooting

### PumpkinMC won't start

```bash
tail -50 minecraft-server/logs/pumpkin.log
```

Common issues:
- Port 25565 already in use: `kill $(lsof -t -i:25565)`
- Corrupted world: delete `pumpkin-server/world/` and restart

### MCSManager won't start

```bash
tail -50 minecraft-server/logs/mcsm-daemon.log
tail -50 minecraft-server/logs/mcsm-web.log
```

### Port conflicts

```bash
lsof -i :25565  # PumpkinMC
lsof -i :23333  # MCSManager web
lsof -i :24444  # MCSManager daemon
lsof -i :3001   # Custom API
```

## Limitations (Replit-specific)

1. **No persistent storage**: Server data is lost when the Replit container restarts.

2. **No incoming ports**: Replit doesn't expose raw TCP ports. External connections require a tunnel service.

3. **Memory constraints**: Replit provides ~8GB RAM. This setup uses ~280MB total.

4. **No systemd**: Services can't auto-restart on system boot.

5. **Process persistence**: Background processes may be killed when the shell session ends. Use the supervisor script.

## Directory Structure

```
minecraft-server/
├── scripts/
│   ├── supervisor.sh        # Start all services (recommended)
│   ├── start.sh             # Start all services
│   ├── stop.sh              # Stop all services
│   ├── restart.sh           # Restart all services
│   ├── status.sh            # Check service status
│   ├── start-mcsm.sh        # Start MCSManager
│   └── start-pumpkin.sh     # Start PumpkinMC
├── api/
│   ├── index.js             # Custom API server
│   ├── package.json         # API dependencies
│   ├── plugin-interface.js  # Plugin interface definitions
│   └── plugin-loader.js     # Plugin loader
├── plugins/                 # Custom plugins go here
├── middleware/               # Middleware for API
├── pumpkin-server/
│   ├── pumpkin              # PumpkinMC binary
│   ├── pumpkin.toml         # Server configuration
│   ├── eula.txt             # EULA acceptance
│   ├── world/               # World data
│   └── data/                # Player data, ops, etc.
├── mcsmanager/
│   ├── daemon/              # MCSManager daemon
│   └── web/                 # MCSManager web panel
├── logs/                    # Service logs
├── .pids/                   # Process ID files
├── mcsm.env                 # Environment config
└── README.md                # This file
```
