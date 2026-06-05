// Tinker server — JSON storage layer with atomic writes + backup rotation
//
// 提供安全的 load/save · 防 data.json 损坏:
//   · 写入时先写 .tmp 文件, fsync, 然后原子 rename (POSIX guarantees atomic on same fs)
//   · 每次成功 save 后保留最近 N 份 backup (旋转)
//   · load 时若 main 文件损坏自动 fallback 到最新 backup
//   · simple in-process lock (Express 是 single-threaded · 防 promise race)

const fs = require('fs');
const path = require('path');

const BACKUP_KEEP = 5; // 保留最近几份 backup

class JsonStorage {
  constructor(filePath, logger) {
    this.filePath = filePath;
    this.tmpPath = filePath + '.tmp';
    this.backupDir = path.join(path.dirname(filePath), 'backups');
    this.log = logger || console;
    this.writeQueue = Promise.resolve();
    if (!fs.existsSync(this.backupDir)) fs.mkdirSync(this.backupDir, { recursive: true });
  }

  load() {
    // 先试主文件
    if (fs.existsSync(this.filePath)) {
      try {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        const data = JSON.parse(raw);
        return { data, source: 'main' };
      } catch (e) {
        this.log.error({ err: e.message }, 'main data file 损坏 · 尝试 backup');
      }
    }
    // fallback: 最新 backup
    const backups = this._listBackups();
    for (const b of backups) {
      try {
        const raw = fs.readFileSync(b, 'utf-8');
        const data = JSON.parse(raw);
        this.log.warn({ backup: b }, '从 backup 恢复');
        return { data, source: 'backup:' + path.basename(b) };
      } catch (e) {
        this.log.error({ backup: b, err: e.message }, 'backup 损坏 · 跳过');
      }
    }
    return { data: null, source: 'none' };
  }

  // save() returns a Promise · serialized so we never race
  save(data) {
    this.writeQueue = this.writeQueue.then(() => this._saveSync(data)).catch(e => {
      this.log.error({ err: e.message }, 'save failed');
    });
    return this.writeQueue;
  }

  _saveSync(data) {
    const json = JSON.stringify(data, null, 2);
    // 1. 写 tmp · fsync · rename (atomic on POSIX)
    const fd = fs.openSync(this.tmpPath, 'w');
    try {
      fs.writeSync(fd, json);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(this.tmpPath, this.filePath);
    // 2. backup rotation
    this._rotate();
  }

  _rotate() {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const target = path.join(this.backupDir, 'data-' + ts + '.json');
    try { fs.copyFileSync(this.filePath, target); } catch (e) { return; }
    const backups = this._listBackups();
    while (backups.length > BACKUP_KEEP) {
      const old = backups.pop();
      try { fs.unlinkSync(old); } catch (e) {}
    }
  }

  _listBackups() {
    if (!fs.existsSync(this.backupDir)) return [];
    return fs.readdirSync(this.backupDir)
      .filter(f => f.startsWith('data-') && f.endsWith('.json'))
      .map(f => path.join(this.backupDir, f))
      .sort((a, b) => b.localeCompare(a)); // newest first
  }
}

module.exports = { JsonStorage };
