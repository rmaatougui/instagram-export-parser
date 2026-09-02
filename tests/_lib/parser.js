// One place that requires report.js, so every test imports the file under
// test from the same path.
'use strict';
const path = require('path');
module.exports = require(path.join(__dirname, '..', '..', 'report.js'));
