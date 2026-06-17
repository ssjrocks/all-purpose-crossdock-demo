# All Purpose Transport Crossdock Demo

A lightweight crossdock coordination demo for driver arrivals, vehicle dispatch,
forklift work, staff messaging, break requests, ad hoc tasks, and operational
history.

## Requirements

- Windows 10 or Windows 11
- Node.js 18 or newer
- A device browser on the same network for mobile testing

For file-based demo storage, no npm packages are required. For MySQL/MariaDB
storage, run `npm install` so the server can use the `mysql2` driver.

## Start the application

Open PowerShell in this directory and run:

```powershell
$env:HOST = "0.0.0.0"
$env:PORT = "4173"
node demo-server.js
```

Open the following pages on the server computer:

- Driver check-in: `http://localhost:4173/driver-checkin.html`
- Manager queue: `http://localhost:4173/manager-queue.html`
- Forklift operator: `http://localhost:4173/forklift-operator.html`
- History: `http://localhost:4173/history.html`
- Statistics: `http://localhost:4173/statistics.html`
- System configuration: `http://localhost:4173/system-configuration.html`

For another device on the same network, replace `localhost` with the server
computer's IPv4 address.

## Demo logins

- Manager username: `manager`
- Manager password: `manager`
- Forklift operator username: the operator's saved name
- Forklift operator temporary password: the same saved name

Forklift operators are required to choose a new password when they first sign in
with the name-based temporary password. The manager can reset an operator back
to that temporary password from System Configuration.

## Data storage

The demo stores its working data in JSON-formatted text files beside the server.
These files are created automatically when the server starts and are excluded
from Git because they can contain driver, staff, message, and activity data.

The server can also use a MySQL-compatible database by setting environment
variables before starting it:

```powershell
$env:CROSSDOCK_STORAGE = "mysql"
$env:MYSQL_HOST = "127.0.0.1"
$env:MYSQL_PORT = "3306"
$env:MYSQL_DATABASE = "crossdock"
$env:MYSQL_USER = "crossdock_app"
$env:MYSQL_PASSWORD = "change-this-password"
node demo-server.js
```

On first MySQL start, the server creates a `crossdock_collections` table and
seeds it from any existing runtime text files, preserving the current queue and
history while moving active storage into the database.

This is a demonstration system. Before production use, add authentication,
authorization, a managed database, backups, HTTPS, auditing, and appropriate
privacy controls.

## Reconstructed commit history

The repository was created after the working demo had already been developed.
Its commits group the available finished files into the major feature milestones
in which the application evolved; they are not exact snapshots of every earlier
prototype.
