const path = require('path');

module.exports = function resolveAsset(name) {
  return path.join('assets', name);
};
