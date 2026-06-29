[Unit]
Description=Snorcal 3D slicing hub
After=network.target

[Service]
Type=simple
WorkingDirectory=%h/snorcal/packages/backend
Environment=NODE_ENV=production
Environment=PORT=${PORT}
Environment=HOST=0.0.0.0
Environment=DATA_DIR=%h/.snorcal/data
ExecStart=${NODE_BIN} %h/snorcal/packages/backend/dist/index.js
Restart=on-failure
RestartSec=5
StandardOutput=append:%h/.snorcal/logs/backend.log
StandardError=append:%h/.snorcal/logs/backend.err.log

[Install]
WantedBy=default.target
