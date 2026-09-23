class Plugin {
  constructor() {
    this._data = null;
  }

  async loadData() {
    return this._data;
  }

  async saveData(data) {
    this._data = data;
  }
}

class TAbstractFile {
  constructor(path) {
    this.path = path;
  }
}

class TFile extends TAbstractFile {}
class TFolder extends TAbstractFile {}

const debounce = (fn) => fn;

module.exports = { Plugin, TAbstractFile, TFile, TFolder, debounce };
