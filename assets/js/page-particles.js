/* 全站背景粒子星座
 *
 * 在 <body> 下插入一块 position:fixed 的 canvas 作为整页背景（z-index 低于内容）。
 * 视觉参考 canvas-nest（NexT 主题里的那个效果）：
 *   - 点以 0.3~0.7px/帧的速度漂移，并叠加一层缓慢变化的风场，看起来是"流动"的；
 *   - 近距点连线；
 *   - 鼠标进入后，附近的点会被轻轻拉向指针，并与指针连线，形成"拖拽"感；
 *   - 点击时把周围点向外推一下。
 *
 * 性能取舍：
 *   - 点数按视口面积算，上限 140；
 *   - 设备像素比封顶 1.5；
 *   - 用 dt 归一化运动，120Hz 屏上也不会变快；
 *   - 标签页切到后台暂停；系统减少动态效果时只画一帧静态图；
 *   - 颜色取自正文字色，明暗主题切换时自动重新取色。
 */
(function () {
  'use strict';

  if (window.__pageParticlesReady) {
    return;
  }
  window.__pageParticlesReady = true;

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  var CONFIG = {
    density: 16000, // 每个点平均占据的像素面积
    maxParticles: 130,
    minParticles: 28,
    linkDistance: 115, // 两点连线的最远距离
    pointerDistance: 190, // 与鼠标连线 / 吸引的最远距离
    pointerPull: 0.03, // 鼠标对点的吸引强度
    clickPush: 26, // 点击时把点推开的距离
    speed: [0.35, 0.8], // 每帧位移范围
    radius: 1.6,
    maxDpr: 1.5,
    maxSpeed: 1.4
  };

  var canvas = document.createElement('canvas');
  canvas.id = 'page-particles';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.insertBefore(canvas, document.body.firstChild);

  var ctx = canvas.getContext('2d');
  if (!ctx) {
    return;
  }

  var width = 0;
  var height = 0;
  var particles = [];
  var pointer = null;
  var rgb = '128, 128, 128';
  var alphaLine = 0.2;
  var alphaDot = 0.45;
  var frameId = null;
  var lastFrame = 0;

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function readTheme() {
    var color = window.getComputedStyle(document.body).color || '';
    var match = color.match(/(\d+)\D+(\d+)\D+(\d+)/);
    if (match) {
      rgb = match[1] + ', ' + match[2] + ', ' + match[3];
    }

    var dark = document.documentElement.getAttribute('data-bs-theme') === 'dark';
    alphaLine = dark ? 0.26 : 0.22;
    alphaDot = dark ? 0.5 : 0.45;
  }

  function createParticles() {
    var count = Math.round((width * height) / CONFIG.density);
    count = clamp(count, CONFIG.minParticles, CONFIG.maxParticles);

    particles = [];
    for (var i = 0; i < count; i++) {
      var angle = Math.random() * Math.PI * 2;
      var speed = CONFIG.speed[0] + Math.random() * (CONFIG.speed[1] - CONFIG.speed[0]);

      particles.push({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed
      });
    }
  }

  function resize() {
    var dpr = Math.min(window.devicePixelRatio || 1, CONFIG.maxDpr);
    width = Math.max(1, document.documentElement.clientWidth);
    height = Math.max(1, document.documentElement.clientHeight);

    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    createParticles();
    draw();
  }

  function moveParticles(dt, time) {
    // 缓慢变化的风场，让整体漂移不是笔直的
    var windX = Math.sin(time * 0.00013) * 0.18;
    var windY = Math.cos(time * 0.00017) * 0.14;

    for (var i = 0; i < particles.length; i++) {
      var p = particles[i];

      p.x += (p.vx + windX) * dt;
      p.y += (p.vy + windY) * dt;

      if (p.x <= 0 || p.x >= width) {
        p.vx = -p.vx;
        p.x = clamp(p.x, 0, width);
      }
      if (p.y <= 0 || p.y >= height) {
        p.vy = -p.vy;
        p.y = clamp(p.y, 0, height);
      }

      if (pointer) {
        var dx = p.x - pointer.x;
        var dy = p.y - pointer.y;
        var dist = Math.sqrt(dx * dx + dy * dy);

        // 拖拽感：只把外圈的点往指针方向拉，避免所有点被吸成一个团
        var near = CONFIG.pointerDistance * 0.55;
        if (dist > near && dist < CONFIG.pointerDistance) {
          var pull = CONFIG.pointerPull * (1 - dist / CONFIG.pointerDistance) * dist * dt;
          p.x -= (dx / dist) * pull;
          p.y -= (dy / dist) * pull;
        }
      }
    }
  }

  function line(x1, y1, x2, y2, alpha) {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.strokeStyle = 'rgba(' + rgb + ', ' + alpha.toFixed(3) + ')';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  function draw() {
    ctx.clearRect(0, 0, width, height);

    var i;
    var j;

    for (i = 0; i < particles.length; i++) {
      for (j = i + 1; j < particles.length; j++) {
        var a = particles[i];
        var b = particles[j];
        var dx = a.x - b.x;
        var dy = a.y - b.y;
        var dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < CONFIG.linkDistance) {
          line(a.x, a.y, b.x, b.y, alphaLine * (1 - dist / CONFIG.linkDistance));
        }
      }
    }

    if (pointer) {
      for (i = 0; i < particles.length; i++) {
        var target = particles[i];
        var pdx = target.x - pointer.x;
        var pdy = target.y - pointer.y;
        var pdist = Math.sqrt(pdx * pdx + pdy * pdy);

        if (pdist < CONFIG.pointerDistance) {
          line(target.x, target.y, pointer.x, pointer.y, alphaLine * 3 * (1 - pdist / CONFIG.pointerDistance));
        }
      }
    }

    for (i = 0; i < particles.length; i++) {
      var dot = particles[i];
      ctx.beginPath();
      ctx.arc(dot.x, dot.y, CONFIG.radius, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(' + rgb + ', ' + alphaDot + ')';
      ctx.fill();
    }
  }

  function tick(now) {
    frameId = window.requestAnimationFrame(tick);

    // dt 归一化：以 60fps 的一帧为 1，掉帧或 120Hz 屏上都保持同样速度
    var dt = lastFrame ? Math.min((now - lastFrame) / 16.667, 3) : 1;
    lastFrame = now;

    moveParticles(dt, now);
    draw();
  }

  function start() {
    lastFrame = 0;
    if (reduceMotion.matches) {
      draw();
      return;
    }
    if (frameId !== null || document.hidden) {
      return;
    }
    frameId = window.requestAnimationFrame(tick);
  }

  function stop() {
    if (frameId !== null) {
      window.cancelAnimationFrame(frameId);
      frameId = null;
    }
    lastFrame = 0;
  }

  function refresh() {
    stop();
    readTheme();
    resize();
    start();
  }

  function pushAway(x, y) {
    for (var i = 0; i < particles.length; i++) {
      var p = particles[i];
      var dx = p.x - x;
      var dy = p.y - y;
      var dist = Math.sqrt(dx * dx + dy * dy);

      if (dist > 0.5 && dist < CONFIG.pointerDistance) {
        var force = (1 - dist / CONFIG.pointerDistance) * CONFIG.clickPush;
        p.x = clamp(p.x + (dx / dist) * force, 0, width);
        p.y = clamp(p.y + (dy / dist) * force, 0, height);
      }
    }
    if (reduceMotion.matches) {
      draw();
    }
  }

  var resizeTimer = null;
  window.addEventListener('resize', function () {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(refresh, 150);
  });

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      stop();
    } else {
      start();
    }
  });

  window.addEventListener('pointermove', function (event) {
    pointer = { x: event.clientX, y: event.clientY };
    if (reduceMotion.matches) {
      draw();
    }
  });

  window.addEventListener('pointerdown', function (event) {
    pointer = { x: event.clientX, y: event.clientY };
    pushAway(event.clientX, event.clientY);
  });

  document.documentElement.addEventListener('pointerleave', function () {
    pointer = null;
    if (reduceMotion.matches) {
      draw();
    }
  });

  // 明暗主题切换后重新取色
  new MutationObserver(function () {
    readTheme();
    draw();
  }).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'data-mode', 'data-bs-theme', 'style']
  });

  if (typeof reduceMotion.addEventListener === 'function') {
    reduceMotion.addEventListener('change', refresh);
  }

  readTheme();
  resize();
  start();
})();
