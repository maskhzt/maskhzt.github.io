/* 页脚粒子星座效果
 *
 * 在一块 canvas 上画若干缓慢游动的点，距离近的点之间连一条线，
 * 鼠标移过页脚时点会被轻轻推开、并与指针连线。
 *
 * 设计上尽量「便宜」：
 *   - 点数量按面积算，最多 70 个，两两连线是 O(n²) 但 n 很小；
 *   - 页脚滚出视口 / 标签页切到后台时暂停 requestAnimationFrame；
 *   - 系统开启「减少动态效果」时只画一帧静态图；
 *   - 颜色取自页脚文字颜色，所以明暗主题切换会自动跟着变。
 */
(function () {
  'use strict';

  var canvas = document.getElementById('footer-particles-canvas');
  if (!canvas || typeof canvas.getContext !== 'function') {
    return;
  }

  var ctx = canvas.getContext('2d');
  if (!ctx) {
    return;
  }

  var footer = canvas.parentElement;
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  var CONFIG = {
    density: 3600, // 每个点平均占据的像素面积
    maxParticles: 90,
    minParticles: 16,
    linkDistance: 140, // 两点连线的最远距离
    pointerDistance: 150, // 与鼠标连线的最远距离
    speed: 0.28, // 每帧最大位移
    radius: 1.6
  };

  var width = 0;
  var height = 0;
  var particles = [];
  var rgb = '128, 128, 128';
  var pointer = null;
  var frameId = null;
  var onScreen = true;

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function readColor() {
    var color = window.getComputedStyle(footer).color || '';
    var match = color.match(/(\d+)\D+(\d+)\D+(\d+)/);
    if (match) {
      rgb = match[1] + ', ' + match[2] + ', ' + match[3];
    }
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
    var rect = footer.getBoundingClientRect();
    var dpr = Math.min(window.devicePixelRatio || 1, 2);

    width = Math.max(1, Math.round(rect.width));
    height = Math.max(1, Math.round(rect.height));

    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
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

      // 鼠标附近轻轻推开，避免点糊在指针上
      if (pointer) {
        var dx = p.x - pointer.x;
        var dy = p.y - pointer.y;
        var dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > 0.01 && dist < 80) {
          var push = ((80 - dist) / 80) * 0.6;
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
          line(a.x, a.y, b.x, b.y, 0.5 * (1 - dist / CONFIG.linkDistance));
        }
      }
    }

    if (pointer) {
      for (i = 0; i < particles.length; i++) {
        var p = particles[i];
        var pdx = p.x - pointer.x;
        var pdy = p.y - pointer.y;
        var pdist = Math.sqrt(pdx * pdx + pdy * pdy);

        if (pdist < CONFIG.pointerDistance) {
          line(p.x, p.y, pointer.x, pointer.y, 0.45 * (1 - pdist / CONFIG.pointerDistance));
        }
      }
    }

    for (i = 0; i < particles.length; i++) {
      var dot = particles[i];
      ctx.beginPath();
      ctx.arc(dot.x, dot.y, CONFIG.radius, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(' + rgb + ', 0.75)';
      ctx.fill();
    }
  }

  function tick() {
    frameId = window.requestAnimationFrame(tick);
    moveParticles();
    draw();
  }

  function start() {
    if (reduceMotion.matches) {
      draw();
      return;
    }
    if (frameId !== null || !onScreen || document.hidden) {
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
    resize();
    start();
  }

  // 页脚尺寸变化（窗口缩放、字体变化）时重建
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(refresh).observe(footer);
  } else {
    window.addEventListener('resize', refresh);
  }

  // 滚出视口就停，省电
  if (typeof IntersectionObserver === 'function') {
    new IntersectionObserver(function (entries) {
      onScreen = entries[0].isIntersecting;
      if (onScreen) {
        start();
      } else {
        stop();
      }
    }).observe(footer);
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      stop();
    } else {
      start();
    }
  });

  // 明暗主题切换后重新取色
  readColor();
  new MutationObserver(function () {
    readColor();
    draw();
  }).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'data-mode', 'data-bs-theme', 'style']
  });

  footer.addEventListener('pointermove', function (event) {
    var rect = footer.getBoundingClientRect();
    pointer = {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top
    };
    if (reduceMotion.matches) {
      draw();
    }
  });

  footer.addEventListener('pointerleave', function () {
    pointer = null;
    if (reduceMotion.matches) {
      draw();
    }
  });

  // 系统「减少动态效果」被切换时重置
  if (typeof reduceMotion.addEventListener === 'function') {
    reduceMotion.addEventListener('change', refresh);
  }

  readColor();
  resize();
  start();
})();
