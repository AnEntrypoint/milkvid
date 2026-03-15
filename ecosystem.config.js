module.exports = {
  apps: [{
    name: 'milkvid-render',
    script: 'render-preset.js',
    interpreter: 'node',
    cwd: 'C:/dev/milkvid',
    autorestart: false,
    windowsHide: true,
    out_file: 'C:/dev/milkvid/render_log.txt',
    error_file: 'C:/dev/milkvid/render_error.txt',
    merge_logs: true,
  }]
};
