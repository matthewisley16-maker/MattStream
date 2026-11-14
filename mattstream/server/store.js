'use strict';

// Tiny JSON persistence layer. Data files live in mattstream/data/.
const fs = require('fs');
const path = require('path');

class Store {
  constructor(file, makeDefault) {
    this.file = file;
    this.makeDefault = makeDefault;
    this.data = null;
    this.timer = null;
    this.dirty = false;
  }

  read() {
    if (this.data) return this.data;
    let parsed = null;
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (err) {
      parsed = null;
    }
    this.data = parsed && typeof parsed === 'object' ? parsed : this.makeDefault();
    return this.data;
  }

  // Replace the whole payload (used for the scanned library index).
  write(next) {
    if (next) this.data = next;
    this.dirty = true;
    this.schedule();
    return this.data;
  }

  // Merge-safe update: mutate through this so writes are debounced.
  update(fn) {
    const data = this.read();
    const result = fn(data);
    this.dirty = true;
    this.schedule();
    return result === undefined ? data : result;
  }

  schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 200);
    if (this.timer.unref) this.timer.unref();
  }

  flush() {
    if (!this.dirty || !this.data) return;
    this.dirty = false;
    const dir = path.dirname(this.file);
    const tmp = this.file + '.tmp';
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      try {
        fs.renameSync(tmp, this.file);
      } catch (err) {
        fs.copyFileSync(tmp, this.file);
        try { fs.unlinkSync(tmp); } catch (e) {}
      }
    } catch (err) {
      console.error('[mattstream] could not save ' + this.file + ': ' + err.message);
    }
  }
}

module.exports = { Store };
