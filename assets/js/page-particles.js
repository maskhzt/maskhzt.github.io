/* 全站背景粒子星座
 *
 * 在 <body> 下插入一块 position:fixed 的 canvas 作为整页背景（z-index 低于内容），
 * 点缓慢游动、近距连线；鼠标移过时点被轻轻推开并与指针连线。
 * 所有页面共用，无外部依赖。
 *
 * 性能取舍：
 *   - 点数按视口面积算，上限 110 个，两两比较 O(n²) 但 n 很小；
 *   - 设备像素比封顶 1.5，避免 4K 屏每帧清空超大画布；
 *   - 帧率锁在 30fps，标签页切到后台时暂停 requestAnimationFrame；
 *   - 系统开启「减少动态效果」时只画一帧静态图；
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
    density: 19000, // 每个点平均占据的像素面积
    maxParticles: 120,
    minParticles: 18,
    linkDistance: 150, // 两点连线的最远距离
    pointerDistance: 170, // 与鼠标连线的最远距离
    speed: 0.22, // 每帧最大位移
    radius: 1.5,
    maxDpr: 1.5
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
  var alphaLine = 0.16;
  var alphaDot = 0.4;
  var frameId = null;
  var lastFrame = 0;
  var FRAME_INTERVAL = 1000 / 30;

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
    alphaLine = dark ? 0.24 : 0.2;
    alphaDot = dark ? 0.5 : 0.45;
  }

  function createParticles() {
    var count = Math.round((width * height) / CONFIG.density);
    count = clamp(count, CONFIG.minParticles, CONFIG.maxParticles);

    particles = [];
    for (var i = 0; i < count; i++) {
      particles.push({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * CONFIG.speed,
        vy: (Math.random() - 0.5) * CONFIG.speed
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

  function moveParticles() {
    for (var i = 0; i < particles.length; i++) {
      var p = particles[i];

      p.x += p.vx;
      p.y += p.vy;

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
        if (dist > 0.01 && dist < 90) {
          var push = ((90 - dist) / 90) * 0.7;
          p.x += (dx / dist) * push;
          p.y += (dy / dist) * push;
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
          line(target.x, target.y, pointer.x, pointer.y, alphaLine * 1.6 * (1 - pdist / CONFIG.pointerDistance));
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

    // 背景动画没必要跑满 60fps，锁到 30fps 更省电
    if (now - lastFrame < FRAME_INTERVAL) {
      return;
    }
    lastFrame = now;

    moveParticles();
    draw();
  }

  function start() {
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
  }

  function refresh() {
    stop();
    readTheme();
    resize();
    start();
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

  window.addEventListener('pointerleave', function () {
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
