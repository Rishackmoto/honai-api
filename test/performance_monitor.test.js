'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { createPerformanceMonitor } = require('../lib/core/network/performance_monitor');

test('does not log tokens, query parameters or IDs', async () => {
  const lines = [];
  const middleware = createPerformanceMonitor({ enabled: true, slowMs: 0, logger: x => lines.push(x) });
  const req = { path: '/api/files/view', method: 'GET', baseUrl: '',
    originalUrl: '/api/files/view?key=private-secret', route: {path:'/api/files/view'},
    headers: { authorization:'Bearer SECRET' } };
  const res = new EventEmitter(); res.statusCode = 200;
  middleware(req,res,()=>{});
  res.emit('finish');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /GET \/api\/files\/view/);
  assert.doesNotMatch(lines[0], /private-secret|SECRET|Bearer/);
});
test('disabled by default does not log', () => {
  const lines=[];
  const middleware=createPerformanceMonitor({enabled:false,slowMs:0,logger:x=>lines.push(x)});
  const res=new EventEmitter();res.statusCode=200;
  middleware({path:'/api/example',method:'GET'},res,()=>{});
  res.emit('finish');
  assert.equal(lines.length,0);
});
test('logs failure even below slow threshold', () => {
  const lines=[];
  const middleware=createPerformanceMonitor({enabled:true,slowMs:100000,logger:x=>lines.push(x)});
  const res=new EventEmitter();res.statusCode=503;
  middleware({path:'/api/test',method:'POST',baseUrl:'',route:{path:'/api/test'}},res,()=>{});
  res.emit('finish');
  assert.equal(lines.length,1);
});
