/**
 * 作业批阅助手 - 核心应用逻辑
 * 实现图片导入、平移缩放、高保真对象化矢量批注与离屏高清导出
 */

(function () {
  'use strict';

  // 状态定义
  const state = {
    images: [], // 列表项: { id, name, img, annotations: [], undoStack: [], redoStack: [] }
    currentIndex: -1,
    view: {
      scale: 1,
      panX: 0,
      panY: 0,
      minScale: 0.1,
      maxScale: 10
    },
    activeTool: 'pen',
    style: {
      color: '#e53e3e',
      size: 4,
      stamp: 'check'
    },
    isDrawing: false,
    isPanning: false,
    panStart: { x: 0, y: 0 },
    currentDraft: null,
    isSpacePressed: false,
    // 双指触控捏合缩放与平移状态
    pinch: {
      active: false,
      dist0: 0,
      center0: { x: 0, y: 0 },
      scale0: 1,
      pan0: { x: 0, y: 0 }
    },
    activePointers: new Map(), // pointerId -> { x, y }
    suppressDrawingUntilAllUp: false, // 双指操作防误触标志
    selectedItem: null, // 当前选中的批注图元
    itemInteraction: null, // { mode: 'move'|'resize'|'rotate', item, ... }
    eraseUndoPushed: false, // 本次橡皮擦拖动是否已记录撤销点
    eraserSize: 32,
    pointer: { x: 0, y: 0, visible: false }
  };

  // DOM 元素缓存
  const dom = {
    canvas: document.getElementById('mainCanvas'),
    viewport: document.getElementById('canvasViewport'),
    dropZone: document.getElementById('dropZone'),
    fileInput: document.getElementById('fileInput'),
    btnImport: document.getElementById('btnImport'),
    btnExport: document.getElementById('btnExport'),
    btnCopyImage: document.getElementById('btnCopyImage'),
    btnUndo: document.getElementById('btnUndo'),
    btnRedo: document.getElementById('btnRedo'),
    btnZoomIn: document.getElementById('btnZoomIn'),
    btnZoomOut: document.getElementById('btnZoomOut'),
    btnFitScreen: document.getElementById('btnFitScreen'),
    btnActualSize: document.getElementById('btnActualSize'),
    zoomLevel: document.getElementById('zoomLevel'),
    docInfo: document.getElementById('docInfo'),
    docFilename: document.getElementById('docFilename'),
    docResolution: document.getElementById('docResolution'),
    toolButtons: document.querySelectorAll('.tool-btn'),
    colorDots: document.querySelectorAll('.color-dot'),
    customColorPicker: document.getElementById('customColorPicker'),
    sizeSlider: document.getElementById('sizeSlider'),
    sizeVal: document.getElementById('sizeVal'),
    eraserSizeGroup: document.getElementById('eraserSizeGroup'),
    eraserSizeSlider: document.getElementById('eraserSizeSlider'),
    eraserSizeVal: document.getElementById('eraserSizeVal'),
    stampPicker: document.getElementById('stampGroup'),
    stampButtons: document.querySelectorAll('.stamp-btn'),
    colorGroup: document.getElementById('colorGroup'),
    sizeGroup: document.getElementById('sizeGroup'),
    btnClearAnnotations: document.getElementById('btnClearAnnotations'),
    selectedStampOps: document.getElementById('selectedStampOps'),
    btnScaleUp: document.getElementById('btnScaleUp'),
    btnScaleDown: document.getElementById('btnScaleDown'),
    btnDeleteSelectedStamp: document.getElementById('btnDeleteSelectedStamp'),
    btnSelectFilePrompt: document.getElementById('btnSelectFilePrompt'),
    thumbnailStrip: document.getElementById('thumbnailStrip'),
    thumbScroll: document.getElementById('thumbScroll'),
    thumbCount: document.getElementById('thumbCount'),
    btnAddMoreImages: document.getElementById('btnAddMoreImages'),
    toastContainer: document.getElementById('toastContainer')
  };

  const ctx = dom.canvas.getContext('2d');

  // ==================== 初始化与事件绑定 ====================
  function init() {
    resizeCanvas();
    window.addEventListener('resize', () => {
      resizeCanvas();
      render();
    });

    bindToolbar();
    bindCanvasEvents();
    bindImageImport();
    bindShortcuts();
    render();
  }

  // 画布尺寸对齐
  function resizeCanvas() {
    const rect = dom.viewport.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    dom.canvas.width = rect.width * dpr;
    dom.canvas.height = rect.height * dpr;
    // canvas 的实际像素尺寸变化后重置变换，避免 resize 时 dpr 反复叠加
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ==================== 图片导入与管理 ====================
  function bindImageImport() {
    dom.fileInput.addEventListener('change', (e) => {
      const files = Array.from(e.target.files || []);
      if (files.length > 0) loadFiles(files);
      dom.fileInput.value = '';
    });

    const triggerFileInput = (e) => {
      if (e && e.currentTarget && e.currentTarget.tagName === 'LABEL') return;
      dom.fileInput.click();
    };

    if (dom.btnImport) dom.btnImport.addEventListener('click', triggerFileInput);
    if (dom.btnAddMoreImages) dom.btnAddMoreImages.addEventListener('click', triggerFileInput);
    if (dom.btnSelectFilePrompt) dom.btnSelectFilePrompt.addEventListener('click', triggerFileInput);

    // 拖拽导入
    dom.viewport.addEventListener('dragover', (e) => {
      e.preventDefault();
      dom.dropZone.classList.add('dragover');
    });

    dom.viewport.addEventListener('dragleave', (e) => {
      e.preventDefault();
      dom.dropZone.classList.remove('dragover');
    });

    dom.viewport.addEventListener('drop', (e) => {
      e.preventDefault();
      dom.dropZone.classList.remove('dragover');
      const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
      if (files.length > 0) loadFiles(files);
    });

    // 剪贴板粘贴导入 (Ctrl+V / Cmd+V)
    window.addEventListener('paste', (e) => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      const imageFiles = [];
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.indexOf('image') !== -1) {
          const file = items[i].getAsFile();
          if (file) imageFiles.push(file);
        }
      }
      if (imageFiles.length > 0) {
        showToast('已从剪贴板读取作业图片');
        loadFiles(imageFiles);
      }
    });
  }

  function loadFiles(files) {
    let loadedCount = 0;
    const initialIndex = state.images.length;

    files.forEach((file) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          state.images.push({
            id: 'img_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
            name: file.name || `作业截图_${new Date().toLocaleTimeString().replace(/:/g, '')}`,
            img: img,
            annotations: [],
            undoStack: [],
            redoStack: []
          });

          loadedCount++;
          if (loadedCount === files.length) {
            updateThumbnails();
            switchImage(initialIndex);
            dom.dropZone.style.display = 'none';
            showToast(`已加载 ${files.length} 张作业图片`);
          }
        };
        img.src = e.target.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function switchImage(index) {
    if (index < 0 || index >= state.images.length) return;
    state.currentIndex = index;
    state.selectedItem = null;
    updateSelectedStampUI();
    updateThumbnails();
    updateDocInfo();
    fitToScreen();
    updateUndoRedoUI();
  }

  function updateDocInfo() {
    const cur = state.images[state.currentIndex];
    if (!cur) {
      dom.docInfo.style.display = 'none';
      return;
    }
    dom.docInfo.style.display = 'flex';
    dom.docFilename.textContent = cur.name;
    dom.docResolution.textContent = `${cur.img.naturalWidth} × ${cur.img.naturalHeight} px`;
  }

  function updateThumbnails() {
    if (state.images.length <= 1) {
      dom.thumbnailStrip.style.display = 'none';
      return;
    }

    dom.thumbnailStrip.style.display = 'flex';
    dom.thumbCount.textContent = state.images.length;
    dom.thumbScroll.innerHTML = '';

    state.images.forEach((item, idx) => {
      const thumb = document.createElement('div');
      thumb.className = `thumb-item ${idx === state.currentIndex ? 'active' : ''}`;
      thumb.title = item.name;

      const img = document.createElement('img');
      img.src = item.img.src;
      thumb.appendChild(img);

      const del = document.createElement('div');
      del.className = 'thumb-remove';
      del.innerHTML = '×';
      del.title = '移除此张';
      del.onclick = (e) => {
        e.stopPropagation();
        removeImage(idx);
      };
      thumb.appendChild(del);

      thumb.onclick = () => switchImage(idx);
      dom.thumbScroll.appendChild(thumb);
    });
  }

  function removeImage(idx) {
    state.images.splice(idx, 1);
    if (state.images.length === 0) {
      state.currentIndex = -1;
      dom.dropZone.style.display = 'flex';
      updateThumbnails();
      updateDocInfo();
      render();
    } else {
      const nextIndex = Math.min(idx, state.images.length - 1);
      switchImage(nextIndex);
    }
  }

  // ==================== 视口与缩放平移 ====================
  function fitToScreen() {
    const cur = state.images[state.currentIndex];
    if (!cur) return;

    const rect = dom.viewport.getBoundingClientRect();
    const padding = 32;
    const availW = rect.width - padding * 2;
    const availH = rect.height - padding * 2;

    const scaleW = availW / cur.img.naturalWidth;
    const scaleH = availH / cur.img.naturalHeight;
    const fitScale = Math.min(scaleW, scaleH, 1.0); // 默认最大不超过 100%

    state.view.scale = Math.max(fitScale, 0.05);
    state.view.panX = (rect.width - cur.img.naturalWidth * state.view.scale) / 2;
    state.view.panY = (rect.height - cur.img.naturalHeight * state.view.scale) / 2;

    updateZoomDisplay();
    render();
  }

  function setActualSize() {
    const cur = state.images[state.currentIndex];
    if (!cur) return;
    const rect = dom.viewport.getBoundingClientRect();
    state.view.scale = 1.0;
    state.view.panX = (rect.width - cur.img.naturalWidth) / 2;
    state.view.panY = (rect.height - cur.img.naturalHeight) / 2;
    updateZoomDisplay();
    render();
  }

  function zoomAt(factor, clientX, clientY) {
    const rect = dom.viewport.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;

    const oldScale = state.view.scale;
    let newScale = oldScale * factor;
    newScale = Math.min(Math.max(newScale, state.view.minScale), state.view.maxScale);

    // 以 (x, y) 为焦点保持缩放
    state.view.panX = x - (x - state.view.panX) * (newScale / oldScale);
    state.view.panY = y - (y - state.view.panY) * (newScale / oldScale);
    state.view.scale = newScale;

    updateZoomDisplay();
    render();
  }

  function updateZoomDisplay() {
    dom.zoomLevel.textContent = `${Math.round(state.view.scale * 100)}%`;
  }

  // ==================== 坐标转换 (Screen <-> World) ====================
  function screenToWorld(sx, sy) {
    return {
      x: (sx - state.view.panX) / state.view.scale,
      y: (sy - state.view.panY) / state.view.scale
    };
  }

  function worldToScreen(wx, wy) {
    return {
      x: wx * state.view.scale + state.view.panX,
      y: wy * state.view.scale + state.view.panY
    };
  }

  // ==================== 工具栏与配置绑定 ====================
  function bindToolbar() {
    // 切换工具
    dom.toolButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        dom.toolButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.activeTool = btn.dataset.tool;
        if (state.activeTool !== 'stamp' && state.selectedItem) {
          state.selectedItem = null;
          updateSelectedStampUI();
          render();
        }

        // 根据工具切换属性栏
        dom.eraserSizeGroup.style.display = state.activeTool === 'eraser' ? 'flex' : 'none';
        if (state.activeTool === 'stamp') {
          dom.stampPicker.style.display = 'flex';
          dom.colorGroup.style.display = 'flex';
          dom.sizeGroup.style.display = 'none';
        } else if (state.activeTool === 'pan' || state.activeTool === 'eraser') {
          dom.stampPicker.style.display = 'none';
          dom.colorGroup.style.display = 'none';
          dom.sizeGroup.style.display = 'none';
        } else {
          dom.stampPicker.style.display = 'none';
          dom.colorGroup.style.display = 'flex';
          dom.sizeGroup.style.display = 'flex';
        }

        dom.viewport.classList.toggle('panning', state.activeTool === 'pan');
      });
    });

    // 颜色切换
    dom.colorDots.forEach((dot) => {
      dot.addEventListener('click', () => {
        dom.colorDots.forEach(d => d.classList.remove('active'));
        dot.classList.add('active');
        state.style.color = dot.dataset.color;
        dom.customColorPicker.value = dot.dataset.color;
      });
    });

    dom.customColorPicker.addEventListener('input', (e) => {
      state.style.color = e.target.value;
      dom.colorDots.forEach(d => d.classList.remove('active'));
    });

    // 粗细滑块
    dom.sizeSlider.addEventListener('input', (e) => {
      state.style.size = parseInt(e.target.value, 10);
      dom.sizeVal.textContent = `${state.style.size}px`;
    });

    dom.eraserSizeSlider.addEventListener('input', (e) => {
      state.eraserSize = parseInt(e.target.value, 10);
      dom.eraserSizeVal.textContent = `${state.eraserSize}px`;
      render();
    });

    // 印章选择
    dom.stampButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        dom.stampButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.style.stamp = btn.dataset.stamp;
      });
    });

    // 缩放按钮
    dom.btnZoomIn.addEventListener('click', () => {
      const rect = dom.viewport.getBoundingClientRect();
      zoomAt(1.2, rect.width / 2 + rect.left, rect.height / 2 + rect.top);
    });

    dom.btnZoomOut.addEventListener('click', () => {
      const rect = dom.viewport.getBoundingClientRect();
      zoomAt(0.8, rect.width / 2 + rect.left, rect.height / 2 + rect.top);
    });

    dom.btnFitScreen.addEventListener('click', fitToScreen);
    dom.btnActualSize.addEventListener('click', setActualSize);

    // 撤销 / 重做
    dom.btnUndo.addEventListener('click', undo);
    dom.btnRedo.addEventListener('click', redo);

    // 清空批注
    dom.btnClearAnnotations.addEventListener('click', () => {
      const cur = state.images[state.currentIndex];
      if (!cur || cur.annotations.length === 0) return;
      if (confirm('确定清空当前作业的所有批注？')) {
        pushUndo();
        cur.annotations = [];
        state.selectedItem = null;
        updateSelectedStampUI();
        updateUndoRedoUI();
        render();
        showToast('已清空所有批注');
      }
    });

    // 导出与复制
    dom.btnExport.addEventListener('click', exportMergedImage);
    dom.btnCopyImage.addEventListener('click', copyMergedImageToClipboard);

    // 选中印章的放大、缩小与清除
    if (dom.btnScaleUp) {
      dom.btnScaleUp.addEventListener('click', () => {
        if (state.selectedItem) {
          pushUndo();
          applyItemScale(state.selectedItem, state.selectedItem, 1.25);
          render();
        }
      });
    }

    if (dom.btnScaleDown) {
      dom.btnScaleDown.addEventListener('click', () => {
        if (state.selectedItem) {
          pushUndo();
          applyItemScale(state.selectedItem, state.selectedItem, 0.8);
          render();
        }
      });
    }

    if (dom.btnDeleteSelectedStamp) {
      dom.btnDeleteSelectedStamp.addEventListener('click', () => {
        deleteSelectedItem();
      });
    }
  }

  // ==================== 画布交互事件 (Pointer Events & 双指缩放) ====================
  function bindCanvasEvents() {
    const vp = dom.viewport;

    // 滚轮缩放 / Mac 触控板双指捏合
    vp.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.ctrlKey) {
        // Mac 触控板双指捏合缩放 (Pinch-to-zoom)
        const factor = 1 - e.deltaY * 0.015;
        zoomAt(factor, e.clientX, e.clientY);
      } else {
        // 普通鼠标滚轮
        const factor = e.deltaY < 0 ? 1.12 : 0.89;
        zoomAt(factor, e.clientX, e.clientY);
      }
    }, { passive: false });

    // iOS Safari 原生双指手势增强保障
    let gestureScale0 = 1;
    vp.addEventListener('gesturestart', (e) => {
      e.preventDefault();
      gestureScale0 = state.view.scale;
      if (state.isDrawing) {
        state.isDrawing = false;
        state.currentDraft = null;
        render();
      }
    });
    vp.addEventListener('gesturechange', (e) => {
      e.preventDefault();
      const targetScale = Math.min(Math.max(gestureScale0 * e.scale, state.view.minScale), state.view.maxScale);
      const rect = vp.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      state.view.panX = cx - (cx - state.view.panX) * (targetScale / state.view.scale);
      state.view.panY = cy - (cy - state.view.panY) * (targetScale / state.view.scale);
      state.view.scale = targetScale;
      updateZoomDisplay();
      render();
    });
    vp.addEventListener('gestureend', (e) => {
      e.preventDefault();
      state.suppressDrawingUntilAllUp = false;
    });

    // PointerDown
    vp.addEventListener('pointerdown', (e) => {
      if (e.target !== dom.canvas && e.target !== vp) return;
      vp.setPointerCapture(e.pointerId);

      const rect = vp.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;

      state.activePointers.set(e.pointerId, { x: sx, y: sy });

      // 当出现 2 个或以上触控点：启动双指捏合缩放与平移模式
      if (state.activePointers.size >= 2) {
        state.suppressDrawingUntilAllUp = true;

        // 如果刚才单指按下时生成了草稿，立即丢弃回滚，避免在画布上留下误触痕迹
        if (state.isDrawing) {
          state.isDrawing = false;
          state.currentDraft = null;
          const cur = state.images[state.currentIndex];
          if (cur && cur.undoStack.length > 0) {
            cur.annotations = cur.undoStack.pop();
          }
          render();
        }
        state.isPanning = false;

        const pts = Array.from(state.activePointers.values());
        const p1 = pts[0];
        const p2 = pts[1];
        state.pinch.active = true;
        state.pinch.dist0 = Math.hypot(p2.x - p1.x, p2.y - p1.y);
        state.pinch.center0 = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
        state.pinch.scale0 = state.view.scale;
        state.pinch.pan0 = { x: state.view.panX, y: state.view.panY };
        return;
      }

      // 如果当前仍处于双指刚结束但手指未全抬起的防误触保护期，抑制单指绘制
      if (state.suppressDrawingUntilAllUp) return;

      // 如果按住了空格键、或者激活了抓手工具、或者鼠标中键/右键，进入平移模式
      if (state.isSpacePressed || state.activeTool === 'pan' || e.button === 1 || e.button === 2) {
        state.isPanning = true;
        state.panStart = { x: sx - state.view.panX, y: sy - state.view.panY };
        vp.classList.add('panning');
        return;
      }

      const cur = state.images[state.currentIndex];
      if (!cur) return;

      const worldPos = screenToWorld(sx, sy);

      // 1. 优先处理当前选中图元的控制点：删除、缩放、旋转、移动
      if (state.activeTool === 'stamp' && state.selectedItem && state.selectedItem.type === 'stamp') {
        const handleHit = hitTestItemHandles(state.selectedItem, sx, sy);
        if (handleHit) {
          if (handleHit.type === 'delete') {
            deleteSelectedItem();
            return;
          }
          pushUndo();
          state.itemInteraction = {
            mode: handleHit.type,
            item: state.selectedItem,
            center: handleHit.center,
            startWx: worldPos.x,
            startWy: worldPos.y,
            orig: snapshotItemGeometry(state.selectedItem),
            startDist: Math.hypot(sx - handleHit.center.x, sy - handleHit.center.y),
            startAngle: Math.atan2(sy - handleHit.center.y, sx - handleHit.center.x),
            startRotation: state.selectedItem.rotation || 0
          };
          return;
        }
      }

      // 2. 点击任意已有批注即可选中并拖动
      const clickedItem = state.activeTool === 'stamp' ? hitTestAnyStamp(worldPos.x, worldPos.y) : null;
      if (clickedItem) {
        state.selectedItem = clickedItem;
        updateSelectedStampUI();
        pushUndo();
        state.itemInteraction = {
          mode: 'move',
          item: clickedItem,
          startWx: worldPos.x,
          startWy: worldPos.y,
          orig: snapshotItemGeometry(clickedItem)
        };
        render();
        return;
      }

      // 3. 点击了空白区域：如果之前有选中印章，先取消选中
      if (state.selectedItem) {
        state.selectedItem = null;
        updateSelectedStampUI();
        render();
      }

      // 印章工具：单次点击落印，并自动框选该新印章方便直接放大缩小或调整
      if (state.activeTool === 'stamp') {
        pushUndo();
        const newStamp = {
          type: 'stamp',
          stampType: state.style.stamp,
          x: worldPos.x,
          y: worldPos.y,
          color: state.style.color,
          scale: 1.0
        };
        cur.annotations.push(newStamp);
        state.selectedItem = newStamp;
        updateSelectedStampUI();
        updateUndoRedoUI();
        render();
        return;
      }

      // 文字工具：弹出即时输入框
      if (state.activeTool === 'text') {
        const text = prompt('请输入批改评语/分值：', '');
        if (text && text.trim()) {
          pushUndo();
          const newText = {
            type: 'text',
            text: text.trim(),
            x: worldPos.x,
            y: worldPos.y,
            color: state.style.color,
            size: Math.max(state.style.size * 5, 20)
          };
          cur.annotations.push(newText);
          state.selectedItem = null;
          updateSelectedStampUI();
          updateUndoRedoUI();
          render();
        }
        return;
      }

      // 橡皮擦工具：开始擦除
      if (state.activeTool === 'eraser') {
        state.eraseUndoPushed = false;
        state.lastErasePos = { x: worldPos.x, y: worldPos.y };
        pushUndo();
        state.eraseUndoPushed = true;
        eraseAt(worldPos.x, worldPos.y);
        state.isDrawing = true;
        return;
      }

      // 绘制工具开始
      state.isDrawing = true;
      pushUndo();

      if (state.activeTool === 'pen' || state.activeTool === 'highlighter') {
        state.currentDraft = {
          type: 'path',
          isHighlighter: state.activeTool === 'highlighter',
          points: [{ x: worldPos.x, y: worldPos.y }],
          color: state.activeTool === 'highlighter' ? state.style.color : state.style.color,
          size: state.activeTool === 'highlighter' ? state.style.size * 3.5 : state.style.size
        };
      } else if (state.activeTool === 'rect') {
        state.currentDraft = {
          type: 'rect',
          startX: worldPos.x,
          startY: worldPos.y,
          x: worldPos.x,
          y: worldPos.y,
          width: 0,
          height: 0,
          color: state.style.color,
          size: state.style.size
        };
      } else if (state.activeTool === 'circle') {
        state.currentDraft = {
          type: 'circle',
          startX: worldPos.x,
          startY: worldPos.y,
          cx: worldPos.x,
          cy: worldPos.y,
          rx: 0,
          ry: 0,
          color: state.style.color,
          size: state.style.size
        };
      } else if (state.activeTool === 'arrow') {
        state.currentDraft = {
          type: 'arrow',
          x1: worldPos.x,
          y1: worldPos.y,
          x2: worldPos.x,
          y2: worldPos.y,
          color: state.style.color,
          size: state.style.size
        };
      }
    });

    // PointerMove
    vp.addEventListener('pointermove', (e) => {
      const rect = vp.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      state.pointer.x = sx;
      state.pointer.y = sy;
      state.pointer.visible = state.activeTool === 'eraser';
      render();

      if (state.activePointers.has(e.pointerId)) {
        state.activePointers.set(e.pointerId, { x: sx, y: sy });
      }

      // 双指缩放和平移中
      if (state.pinch.active && state.activePointers.size >= 2) {
        const pts = Array.from(state.activePointers.values());
        const p1 = pts[0];
        const p2 = pts[1];
        const newDist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
        const newCenter = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };

        if (state.pinch.dist0 > 0) {
          const ratio = newDist / state.pinch.dist0;
          let targetScale = state.pinch.scale0 * ratio;
          targetScale = Math.min(Math.max(targetScale, state.view.minScale), state.view.maxScale);

          // 以初始双指中心为锚点保持平滑缩放与同步平移
          const worldOriginX = (state.pinch.center0.x - state.pinch.pan0.x) / state.pinch.scale0;
          const worldOriginY = (state.pinch.center0.y - state.pinch.pan0.y) / state.pinch.scale0;

          state.view.scale = targetScale;
          state.view.panX = newCenter.x - worldOriginX * targetScale;
          state.view.panY = newCenter.y - worldOriginY * targetScale;

          updateZoomDisplay();
          render();
        }
        return;
      }

      if (state.suppressDrawingUntilAllUp) return;

      // 正在拖拽任意图元的移动、缩放或旋转控制点
      const worldPos = screenToWorld(sx, sy);
      if (state.itemInteraction) {
        const interaction = state.itemInteraction;
        const item = interaction.item;
        if (interaction.mode === 'resize') {
          const currentDist = Math.hypot(sx - interaction.center.x, sy - interaction.center.y);
          const factor = interaction.startDist > 0 ? currentDist / interaction.startDist : 1;
          applyItemScale(item, interaction.orig, Math.min(Math.max(factor, 0.15), 8));
        } else if (interaction.mode === 'rotate') {
          const angle = Math.atan2(sy - interaction.center.y, sx - interaction.center.x);
          item.rotation = (interaction.startRotation || 0) + angle - interaction.startAngle;
        } else if (interaction.mode === 'move') {
          moveItemByDelta(item, interaction.orig, worldPos.x - interaction.startWx, worldPos.y - interaction.startWy);
        }
        render();
        return;
      }

      if (state.isPanning) {
        state.view.panX = sx - state.panStart.x;
        state.view.panY = sy - state.panStart.y;
        render();
        return;
      }

      // 鼠标悬停时的控制点光标提示
      if (!state.isDrawing) {
        if (state.selectedItem) {
          const hoverHit = hitTestItemHandles(state.selectedItem, sx, sy);
          if (hoverHit) {
            if (hoverHit.type === 'delete') vp.style.cursor = 'pointer';
            else if (hoverHit.type === 'rotate') vp.style.cursor = 'crosshair';
            else if (hoverHit.type === 'resize') vp.style.cursor = 'nwse-resize';
            else if (hoverHit.type === 'move') vp.style.cursor = 'move';
            return;
          }
        }
        if (hitTestAnyItem(worldPos.x, worldPos.y)) {
          vp.style.cursor = 'pointer';
          return;
        }
        vp.style.cursor = (state.activeTool === 'pan') ? 'grab' : 'crosshair';
      }

      if (!state.isDrawing) return;

      if (state.activeTool === 'eraser') {
        // 胶囊体擦除：从上一个位置到当前位置的连续路径
        const last = state.lastErasePos || worldPos;
        eraseAt(worldPos.x, worldPos.y, last.x, last.y);
        state.lastErasePos = { x: worldPos.x, y: worldPos.y };
        return;
      }

      if (!state.currentDraft) return;

      if (state.currentDraft.type === 'path') {
        state.currentDraft.points.push({ x: worldPos.x, y: worldPos.y });
      } else if (state.currentDraft.type === 'rect') {
        state.currentDraft.x = Math.min(state.currentDraft.startX, worldPos.x);
        state.currentDraft.y = Math.min(state.currentDraft.startY, worldPos.y);
        state.currentDraft.width = Math.abs(worldPos.x - state.currentDraft.startX);
        state.currentDraft.height = Math.abs(worldPos.y - state.currentDraft.startY);
      } else if (state.currentDraft.type === 'circle') {
        const startX = state.currentDraft.startX;
        const startY = state.currentDraft.startY;
        state.currentDraft.cx = (startX + worldPos.x) / 2;
        state.currentDraft.cy = (startY + worldPos.y) / 2;
        state.currentDraft.rx = Math.abs(worldPos.x - startX) / 2;
        state.currentDraft.ry = Math.abs(worldPos.y - startY) / 2;
      } else if (state.currentDraft.type === 'arrow') {
        state.currentDraft.x2 = worldPos.x;
        state.currentDraft.y2 = worldPos.y;
      }

      render();
    });

    // PointerUp / Cancel / Leave
    const endInteraction = (e) => {
      state.activePointers.delete(e.pointerId);

      if (state.activePointers.size < 2 && state.pinch.active) {
        state.pinch.active = false;
      }

      // 当所有触控点全部离屏时，解除防误触保护
      if (state.activePointers.size === 0) {
        state.suppressDrawingUntilAllUp = false;
      }

      if (state.isPanning) {
        state.isPanning = false;
        if (state.activeTool !== 'pan' && !state.isSpacePressed) {
          vp.classList.remove('panning');
        }
      }

      if (state.itemInteraction) {
        state.itemInteraction = null;
      }

      if (state.isDrawing) {
        state.isDrawing = false;
        const cur = state.images[state.currentIndex];
        if (cur && state.currentDraft) {
          cur.annotations.push(state.currentDraft);
          state.selectedItem = null;
          state.currentDraft = null;
          updateSelectedStampUI();
          updateUndoRedoUI();
          render();
        }
      }
    };

    vp.addEventListener('pointerleave', () => {
      state.pointer.visible = false;
      render();
    });

    vp.addEventListener('pointerup', endInteraction);
    vp.addEventListener('pointercancel', endInteraction);
    vp.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'mouse' && e.buttons === 0) {
        endInteraction(e);
      }
    });
  }

  // 橡皮擦：对 path 做精确几何裁剪，其他类型整体删除
  // 支持胶囊体擦除：从 (wx0,wy0) 到 (wx1,wy1) 的移动路径
  function eraseAt(wx, wy, wx0, wy0) {
    const cur = state.images[state.currentIndex];
    if (!cur) return false;
    const eraserR = state.eraserSize / (2 * state.view.scale);
    let anyChanged = false;
    // 如果有上一个点，用胶囊体裁剪；否则用单点圆裁剪
    const useCapsule = (wx0 !== undefined && wy0 !== undefined &&
                        (Math.abs(wx - wx0) > 0.01 || Math.abs(wy - wy0) > 0.01));

    for (let idx = cur.annotations.length - 1; idx >= 0; idx--) {
      const item = cur.annotations[idx];
      if (item.type === 'path' && item.points && item.points.length >= 2) {
        const r = eraserR + item.size / 2;
        const newSegments = useCapsule
          ? clipPathByCapsule(item.points, wx0, wy0, wx, wy, r)
          : clipPathByCircle(item.points, wx, wy, r);
        if (newSegments === null) continue;
        anyChanged = true;
        const replacements = newSegments
          .filter(seg => seg.length >= 2)
          .map(seg => ({ ...item, points: seg, isErasedFragment: true }));
        cur.annotations.splice(idx, 1, ...replacements);
      } else {
        if (pointInItem(item, wx, wy, eraserR)) {
          cur.annotations.splice(idx, 1);
          anyChanged = true;
        }
      }
    }

    if (anyChanged) {
      if (state.selectedItem && !cur.annotations.includes(state.selectedItem)) {
        state.selectedItem = null;
        updateSelectedStampUI();
      }
      updateUndoRedoUI();
      render();
    }
    return anyChanged;
  }

  // 判断点 (px,py) 是否在胶囊体内（线段(ax,ay)-(bx,by)的 r 范围内）
  function pointInCapsule(px, py, ax, ay, bx, by, r) {
    return distanceToSegment(px, py, ax, ay, bx, by) <= r;
  }

  // 胶囊体裁剪：擦除路径从 (ax,ay) 到 (bx,by)，半径 r
  function clipPathByCapsule(points, ax, ay, bx, by, r) {
    // 快速排除：检查是否有任何点或线段接近胶囊体
    let anyClose = false;
    for (let i = 0; i < points.length; i++) {
      if (distanceToSegment(points[i].x, points[i].y, ax, ay, bx, by) <= r + 5) {
        anyClose = true; break;
      }
    }
    if (!anyClose) return null;

    // 对路径上的每个点判断是否在胶囊体内
    // 对每条线段，找到进入/离开胶囊体的精确位置
    const segments = [];
    let currentSeg = [];

    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const pInside = pointInCapsule(p.x, p.y, ax, ay, bx, by, r);

      if (i === 0) {
        if (!pInside) currentSeg.push(p);
        continue;
      }

      const prev = points[i - 1];
      const prevInside = pointInCapsule(prev.x, prev.y, ax, ay, bx, by, r);

      if (!prevInside && !pInside) {
        // 两端都在外面，检查中间是否穿过胶囊体
        const crossPt = findCapsuleCrossing(prev, p, ax, ay, bx, by, r);
        if (crossPt) {
          currentSeg.push(crossPt.enter);
          if (currentSeg.length >= 2) segments.push(currentSeg);
          currentSeg = [crossPt.exit];
        }
        currentSeg.push(p);
      } else if (!prevInside && pInside) {
        // 从外进入胶囊体
        const boundary = binarySearchBoundary(prev, p, ax, ay, bx, by, r, false);
        currentSeg.push(boundary);
        if (currentSeg.length >= 2) segments.push(currentSeg);
        currentSeg = [];
      } else if (prevInside && !pInside) {
        // 从胶囊体出来
        const boundary = binarySearchBoundary(prev, p, ax, ay, bx, by, r, true);
        currentSeg = [boundary];
        currentSeg.push(p);
      }
      // prevInside && pInside: 都在胶囊体内，跳过
    }

    if (currentSeg.length >= 2) segments.push(currentSeg);

    // 检查是否实际有变化
    if (segments.length === 1 && segments[0].length === points.length) {
      let same = true;
      for (let i = 0; i < points.length; i++) {
        if (segments[0][i] !== points[i]) { same = false; break; }
      }
      if (same) return null;
    }

    return segments;
  }

  // 二分查找线段上进入/离开胶囊体的精确边界点
  function binarySearchBoundary(pOut, pIn, ax, ay, bx, by, r, exitMode) {
    let lo = 0, hi = 1;
    // exitMode: true 表示从 inside 到 outside，pOut=prev(inside), pIn=p(outside)
    // 实际上参数顺序：exitMode=false 时 pOut 在外 pIn 在内
    let outT, inT;
    if (exitMode) {
      // prev inside, p outside: 找从 prev 到 p 的边界
      outT = 1; inT = 0;
    } else {
      outT = 0; inT = 1;
    }

    for (let iter = 0; iter < 16; iter++) {
      const mid = (lo + hi) / 2;
      const mx = pOut.x + (pIn.x - pOut.x) * mid;
      const my = pOut.y + (pIn.y - pOut.y) * mid;
      const inside = pointInCapsule(mx, my, ax, ay, bx, by, r);
      if (exitMode) {
        // 从 inside(lo) 到 outside(hi)
        if (inside) lo = mid; else hi = mid;
      } else {
        // 从 outside(lo) 到 inside(hi)
        if (inside) hi = mid; else lo = mid;
      }
    }
    const t = (lo + hi) / 2;
    return { x: pOut.x + (pIn.x - pOut.x) * t, y: pOut.y + (pIn.y - pOut.y) * t };
  }

  // 检查线段是否穿过胶囊体（两端都在外但中间穿过）
  function findCapsuleCrossing(prev, p, ax, ay, bx, by, r) {
    // 采样检查中间是否有点在胶囊体内
    const steps = 8;
    let enterIdx = -1;
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      const mx = prev.x + (p.x - prev.x) * t;
      const my = prev.y + (p.y - prev.y) * t;
      if (pointInCapsule(mx, my, ax, ay, bx, by, r)) {
        enterIdx = s;
        break;
      }
    }
    if (enterIdx < 0) return null;

    // 找进入点
    let loE = (enterIdx - 1) / steps, hiE = enterIdx / steps;
    for (let iter = 0; iter < 16; iter++) {
      const mid = (loE + hiE) / 2;
      const mx = prev.x + (p.x - prev.x) * mid;
      const my = prev.y + (p.y - prev.y) * mid;
      if (pointInCapsule(mx, my, ax, ay, bx, by, r)) hiE = mid; else loE = mid;
    }
    const enterT = (loE + hiE) / 2;

    // 找离开点
    let loX = enterT, hiX = 1;
    // 先找到一个在外面的点
    for (let s = Math.ceil(enterIdx); s <= steps; s++) {
      const t = s / steps;
      const mx = prev.x + (p.x - prev.x) * t;
      const my = prev.y + (p.y - prev.y) * t;
      if (!pointInCapsule(mx, my, ax, ay, bx, by, r)) {
        hiX = t;
        break;
      }
      loX = t;
    }
    for (let iter = 0; iter < 16; iter++) {
      const mid = (loX + hiX) / 2;
      const mx = prev.x + (p.x - prev.x) * mid;
      const my = prev.y + (p.y - prev.y) * mid;
      if (pointInCapsule(mx, my, ax, ay, bx, by, r)) loX = mid; else hiX = mid;
    }
    const exitT = (loX + hiX) / 2;

    return {
      enter: { x: prev.x + (p.x - prev.x) * enterT, y: prev.y + (p.y - prev.y) * enterT },
      exit: { x: prev.x + (p.x - prev.x) * exitT, y: prev.y + (p.y - prev.y) * exitT }
    };
  }

  // 精确裁剪：将一条 path 被圆(cx,cy,r)覆盖的部分切掉，返回剩余片段数组
  // 返回 null 表示完全没有被擦到
  function clipPathByCircle(points, cx, cy, r) {
    const r2 = r * r;
    // 快速判断：如果所有点都远离圆心，跳过
    let anyClose = false;
    for (let i = 0; i < points.length; i++) {
      if (Math.hypot(points[i].x - cx, points[i].y - cy) <= r + 5) { anyClose = true; break; }
      if (i > 0 && distanceToSegment(cx, cy, points[i-1].x, points[i-1].y, points[i].x, points[i].y) <= r + 5) { anyClose = true; break; }
    }
    if (!anyClose) return null;

    // 对每条线段做圆裁剪，收集"在圆外"的子段
    const segments = [];
    let currentSeg = [];

    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const pInside = (p.x - cx) * (p.x - cx) + (p.y - cy) * (p.y - cy) <= r2;

      if (i === 0) {
        if (!pInside) currentSeg.push(p);
        continue;
      }

      const prev = points[i - 1];
      const prevInside = (prev.x - cx) * (prev.x - cx) + (prev.y - cy) * (prev.y - cy) <= r2;

      // 求线段与圆的交点
      const intersections = lineSegCircleIntersections(prev.x, prev.y, p.x, p.y, cx, cy, r);

      if (!prevInside && !pInside) {
        // 两端都在外面
        if (intersections.length >= 2) {
          // 线段穿过圆：在进入点截断，开始新段在离开点
          currentSeg.push(intersections[0]);
          if (currentSeg.length >= 2) segments.push(currentSeg);
          currentSeg = [intersections[1]];
        } else {
          // 没有穿过圆，继续当前段
          currentSeg.push(p);
        }
      } else if (!prevInside && pInside) {
        // 从外进入圆内：在交点处截断
        if (intersections.length > 0) {
          currentSeg.push(intersections[0]);
        }
        if (currentSeg.length >= 2) segments.push(currentSeg);
        currentSeg = [];
      } else if (prevInside && !pInside) {
        // 从圆内出来：在交点处开始新段
        if (intersections.length > 0) {
          currentSeg = [intersections[intersections.length - 1]];
        } else {
          currentSeg = [];
        }
        currentSeg.push(p);
      }
      // prevInside && pInside: 都在圆内，跳过
    }

    if (currentSeg.length >= 2) segments.push(currentSeg);

    // 如果结果和原始完全一样，说明没擦到
    if (segments.length === 1 && segments[0].length === points.length) {
      let same = true;
      for (let i = 0; i < points.length; i++) {
        if (segments[0][i] !== points[i]) { same = false; break; }
      }
      if (same) return null;
    }
    if (segments.length === 0 && !anyClose) return null;

    return segments;
  }

  // 线段(x1,y1)-(x2,y2)与圆(cx,cy,r)的交点，按 t 排序
  function lineSegCircleIntersections(x1, y1, x2, y2, cx, cy, r) {
    const dx = x2 - x1, dy = y2 - y1;
    const fx = x1 - cx, fy = y1 - cy;
    const a = dx * dx + dy * dy;
    if (a < 1e-10) return [];
    const b = 2 * (fx * dx + fy * dy);
    const c = fx * fx + fy * fy - r * r;
    let disc = b * b - 4 * a * c;
    if (disc < 0) return [];
    disc = Math.sqrt(disc);
    const results = [];
    const t1 = (-b - disc) / (2 * a);
    const t2 = (-b + disc) / (2 * a);
    if (t1 >= 0.001 && t1 <= 0.999) results.push({ x: x1 + t1 * dx, y: y1 + t1 * dy, t: t1 });
    if (t2 >= 0.001 && t2 <= 0.999 && Math.abs(t2 - t1) > 0.001) results.push({ x: x1 + t2 * dx, y: y1 + t2 * dy, t: t2 });
    results.sort((a, b) => a.t - b.t);
    return results;
  }

  // ==================== 撤销 / 重做 ====================
  function pushUndo() {
    const cur = state.images[state.currentIndex];
    if (!cur) return;
    // 深拷贝当前批注状态
    cur.undoStack.push(JSON.parse(JSON.stringify(cur.annotations)));
    cur.redoStack = []; // 动作发生后清空 redo 栈
    updateUndoRedoUI();
  }

  function undo() {
    const cur = state.images[state.currentIndex];
    if (!cur || cur.undoStack.length === 0) return;
    cur.redoStack.push(JSON.parse(JSON.stringify(cur.annotations)));
    cur.annotations = cur.undoStack.pop();
    state.selectedItem = null;
    updateSelectedStampUI();
    updateUndoRedoUI();
    render();
  }

  function redo() {
    const cur = state.images[state.currentIndex];
    if (!cur || cur.redoStack.length === 0) return;
    cur.undoStack.push(JSON.parse(JSON.stringify(cur.annotations)));
    cur.annotations = cur.redoStack.pop();
    state.selectedItem = null;
    updateSelectedStampUI();
    updateUndoRedoUI();
    render();
  }

  function updateUndoRedoUI() {
    const cur = state.images[state.currentIndex];
    if (!cur) {
      dom.btnUndo.disabled = true;
      dom.btnRedo.disabled = true;
      return;
    }
    dom.btnUndo.disabled = cur.undoStack.length === 0;
    dom.btnRedo.disabled = cur.redoStack.length === 0;
  }

  // ==================== 快捷键体系 ====================
  function bindShortcuts() {
    window.addEventListener('keydown', (e) => {
      // 避免输入框打字触发快捷键
      if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
      } else if (e.code === 'Space' && !state.isSpacePressed) {
        state.isSpacePressed = true;
        dom.viewport.classList.add('panning');
      } else if (e.key.toLowerCase() === 'p') {
        activateTool('pen');
      } else if (e.key.toLowerCase() === 'h') {
        activateTool('highlighter');
      } else if (e.key.toLowerCase() === 's') {
        activateTool('stamp');
      } else if (e.key.toLowerCase() === 'r') {
        activateTool('rect');
      } else if (e.key.toLowerCase() === 'c') {
        activateTool('circle');
      } else if (e.key.toLowerCase() === 'a') {
        activateTool('arrow');
      } else if (e.key.toLowerCase() === 't') {
        activateTool('text');
      } else if (e.key.toLowerCase() === 'e') {
        activateTool('eraser');
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (state.selectedItem) {
          e.preventDefault();
          deleteSelectedItem();
        }
      }
    });

    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') {
        state.isSpacePressed = false;
        if (state.activeTool !== 'pan') {
          dom.viewport.classList.remove('panning');
        }
      }
    });
  }

  function activateTool(toolName) {
    const btn = Array.from(dom.toolButtons).find(b => b.dataset.tool === toolName);
    if (btn) btn.click();
  }

  // ==================== 核心渲染器 (Screen Canvas) ====================
  function render() {
    const rect = dom.viewport.getBoundingClientRect();
    ctx.clearRect(0, 0, rect.width, rect.height);

    const cur = state.images[state.currentIndex];
    if (!cur) return;

    ctx.save();
    // 应用平移与缩放矩阵
    ctx.translate(state.view.panX, state.view.panY);
    ctx.scale(state.view.scale, state.view.scale);

    // 1. 绘制底图
    ctx.drawImage(cur.img, 0, 0);

    // 2. 普通批注先绘制；荧光笔统一合成一次，避免反复叠加变深
    cur.annotations.filter(item => !item.isHighlighter).forEach(item => drawAnnotationItem(ctx, item));
    if (state.currentDraft && !state.currentDraft.isHighlighter) {
      drawAnnotationItem(ctx, state.currentDraft);
    }

    const highlighters = cur.annotations.filter(item => item.isHighlighter);
    if (state.currentDraft && state.currentDraft.isHighlighter) highlighters.push(state.currentDraft);
    if (highlighters.length) {
      const layer = document.createElement('canvas');
      layer.width = dom.canvas.width;
      layer.height = dom.canvas.height;
      const layerCtx = layer.getContext('2d');
      layerCtx.save();
      layerCtx.translate(state.view.panX, state.view.panY);
      layerCtx.scale(state.view.scale, state.view.scale);
      highlighters.forEach(item => drawAnnotationItem(layerCtx, item, { flatHighlighter: true }));
      layerCtx.restore();
      ctx.restore();
      ctx.save();
      ctx.globalAlpha = 0.35;
      ctx.drawImage(layer, 0, 0);
      ctx.restore();
    } else {
      ctx.restore();
    }

    // 4. 绘制选中图元的高亮框、缩放/旋转/删除控制点
    if (state.selectedItem && state.selectedItem.type === 'stamp') {
      drawSelectionBox(ctx, state.selectedItem);
    }

    if (state.pointer.visible && state.activeTool === 'eraser') {
      const radius = state.eraserSize / 2;
      ctx.save();
      ctx.beginPath();
      ctx.arc(state.pointer.x, state.pointer.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#e53e3e';
      ctx.setLineDash([4, 3]);
      ctx.stroke();
      ctx.restore();
    }
  }

  // 绘制单个批注图元
  function drawAnnotationItem(targetCtx, item, options = {}) {
    targetCtx.save();
    const center = getItemCenter(item);
    if (item.rotation) {
      targetCtx.translate(center.x, center.y);
      targetCtx.rotate(item.rotation);
      targetCtx.translate(-center.x, -center.y);
    }

    if (item.type === 'path') {
      if (!item.points || item.points.length < 2) {
        targetCtx.restore();
        return;
      }
      targetCtx.beginPath();
      targetCtx.lineCap = 'round';
      targetCtx.lineJoin = 'round';
      targetCtx.lineWidth = item.size;

      if (item.isHighlighter) {
        targetCtx.strokeStyle = item.color;
        targetCtx.globalAlpha = options.flatHighlighter ? 1.0 : 0.35;
      } else {
        targetCtx.strokeStyle = item.color;
        targetCtx.globalAlpha = 1.0;
      }

      targetCtx.moveTo(item.points[0].x, item.points[0].y);
      for (let i = 1; i < item.points.length; i++) {
        targetCtx.lineTo(item.points[i].x, item.points[i].y);
      }
      targetCtx.stroke();
    } else if (item.type === 'rect') {
      targetCtx.strokeStyle = item.color;
      targetCtx.lineWidth = item.size;
      targetCtx.strokeRect(item.x, item.y, item.width, item.height);
    } else if (item.type === 'circle') {
      targetCtx.strokeStyle = item.color;
      targetCtx.lineWidth = item.size;
      targetCtx.beginPath();
      targetCtx.ellipse(item.cx, item.cy, Math.max(item.rx, 1), Math.max(item.ry, 1), 0, 0, Math.PI * 2);
      targetCtx.stroke();
    } else if (item.type === 'arrow') {
      drawArrow(targetCtx, item.x1, item.y1, item.x2, item.y2, item.color, item.size);
    } else if (item.type === 'text') {
      targetCtx.font = `bold ${item.size}px sans-serif`;
      targetCtx.fillStyle = item.color;
      targetCtx.textBaseline = 'bottom';
      targetCtx.fillText(item.text, item.x, item.y);
    } else if (item.type === 'stamp') {
      drawStamp(targetCtx, item.stampType, item.x, item.y, item.color, item.scale || 1.0);
    }

    targetCtx.restore();
  }

  // 绘制专业箭头
  function drawArrow(targetCtx, x1, y1, x2, y2, color, size) {
    const headLength = Math.max(size * 4, 16);
    const angle = Math.atan2(y2 - y1, x2 - x1);

    targetCtx.strokeStyle = color;
    targetCtx.fillStyle = color;
    targetCtx.lineWidth = size;
    targetCtx.lineCap = 'round';

    targetCtx.beginPath();
    targetCtx.moveTo(x1, y1);
    targetCtx.lineTo(x2, y2);
    targetCtx.stroke();

    // 箭头头部三角形
    targetCtx.beginPath();
    targetCtx.moveTo(x2, y2);
    targetCtx.lineTo(
      x2 - headLength * Math.cos(angle - Math.PI / 6),
      y2 - headLength * Math.sin(angle - Math.PI / 6)
    );
    targetCtx.lineTo(
      x2 - headLength * Math.cos(angle + Math.PI / 6),
      y2 - headLength * Math.sin(angle + Math.PI / 6)
    );
    targetCtx.closePath();
    targetCtx.fill();
  }

  // 绘制教师专属批阅印章 (支持自定义缩放比例 scale)
  function drawStamp(targetCtx, stampType, x, y, color, scale = 1.0) {
    targetCtx.save();
    targetCtx.translate(x, y);
    targetCtx.scale(scale, scale);

    if (stampType === 'check') {
      // ✔ 对勾
      targetCtx.strokeStyle = color || '#38a169';
      targetCtx.lineWidth = 6;
      targetCtx.lineCap = 'round';
      targetCtx.lineJoin = 'round';
      targetCtx.beginPath();
      targetCtx.moveTo(-16, 2);
      targetCtx.lineTo(-4, 16);
      targetCtx.lineTo(20, -14);
      targetCtx.stroke();
    } else if (stampType === 'cross') {
      // ✘ 错叉
      targetCtx.strokeStyle = color || '#e53e3e';
      targetCtx.lineWidth = 6;
      targetCtx.lineCap = 'round';
      targetCtx.beginPath();
      targetCtx.moveTo(-14, -14);
      targetCtx.lineTo(14, 14);
      targetCtx.moveTo(14, -14);
      targetCtx.lineTo(-14, 14);
      targetCtx.stroke();
    } else if (stampType === 'score100') {
      // 💯 100分印章
      targetCtx.strokeStyle = '#e53e3e';
      targetCtx.fillStyle = '#e53e3e';
      targetCtx.lineWidth = 3;
      targetCtx.beginPath();
      targetCtx.ellipse(0, 0, 34, 22, -0.1, 0, Math.PI * 2);
      targetCtx.stroke();

      targetCtx.font = 'bold 22px sans-serif';
      targetCtx.textAlign = 'center';
      targetCtx.textBaseline = 'middle';
      targetCtx.fillText('100', 0, -1);

      // 双下划线
      targetCtx.lineWidth = 2;
      targetCtx.beginPath();
      targetCtx.moveTo(-20, 12);
      targetCtx.lineTo(20, 10);
      targetCtx.moveTo(-16, 16);
      targetCtx.lineTo(16, 14);
      targetCtx.stroke();
    } else if (stampType === 'great') {
      // 优秀印章
      targetCtx.strokeStyle = '#e53e3e';
      targetCtx.fillStyle = '#e53e3e';
      targetCtx.lineWidth = 3;
      targetCtx.strokeRect(-32, -18, 64, 36);

      targetCtx.font = 'bold 18px "PingFang SC", "Microsoft YaHei", sans-serif';
      targetCtx.textAlign = 'center';
      targetCtx.textBaseline = 'middle';
      targetCtx.fillText('优 秀', 0, 1);
    } else if (stampType === 'read') {
      // 已阅圆章
      targetCtx.strokeStyle = '#e53e3e';
      targetCtx.fillStyle = '#e53e3e';
      targetCtx.lineWidth = 3;
      targetCtx.beginPath();
      targetCtx.arc(0, 0, 24, 0, Math.PI * 2);
      targetCtx.stroke();

      targetCtx.font = 'bold 16px "PingFang SC", "Microsoft YaHei", sans-serif';
      targetCtx.textAlign = 'center';
      targetCtx.textBaseline = 'middle';
      targetCtx.fillText('阅', 0, 1);
    } else if (stampType === 'question') {
      // 疑问印章
      targetCtx.font = 'bold 36px sans-serif';
      targetCtx.fillStyle = color || '#dd6b20';
      targetCtx.textAlign = 'center';
      targetCtx.textBaseline = 'middle';
      targetCtx.fillText('?', 0, 0);
    }

    targetCtx.restore();
  }

  // ==================== 通用图元选中、缩放、旋转与清除 ====================
  const STAMP_BASE_SIZES = {
    check: { w: 46, h: 42 }, cross: { w: 38, h: 38 }, score100: { w: 76, h: 54 },
    great: { w: 72, h: 46 }, read: { w: 56, h: 56 }, question: { w: 42, h: 52 }
  };

  function getItemBounds(item) {
    if (item.type === 'stamp') {
      const b = STAMP_BASE_SIZES[item.stampType] || { w: 50, h: 50 };
      const s = item.scale || 1;
      return { minX: item.x - b.w*s/2, maxX: item.x + b.w*s/2, minY: item.y - b.h*s/2, maxY: item.y + b.h*s/2 };
    }
    if (item.type === 'rect') return { minX: item.x, minY: item.y, maxX: item.x + item.width, maxY: item.y + item.height };
    if (item.type === 'circle') return { minX: item.cx-item.rx, maxX: item.cx+item.rx, minY: item.cy-item.ry, maxY: item.cy+item.ry };
    if (item.type === 'arrow') return { minX: Math.min(item.x1,item.x2), maxX: Math.max(item.x1,item.x2), minY: Math.min(item.y1,item.y2), maxY: Math.max(item.y1,item.y2) };
    if (item.type === 'text') {
      const w = Math.max(24, (item.text || '').length * item.size * 0.62);
      return { minX: item.x, maxX: item.x+w, minY: item.y-item.size, maxY: item.y+5 };
    }
    if (item.type === 'path' && item.points && item.points.length) {
      const xs=item.points.map(p=>p.x), ys=item.points.map(p=>p.y);
      return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
    }
    return { minX: item.x || 0, maxX: (item.x || 0)+30, minY: item.y || 0, maxY: (item.y || 0)+30 };
  }

  function getItemCenter(item) {
    const b=getItemBounds(item);
    return { x:(b.minX+b.maxX)/2, y:(b.minY+b.maxY)/2 };
  }

  function getItemScreenBox(item) {
    const b=getItemBounds(item), c=getItemCenter(item);
    const tl=worldToScreen(b.minX,b.minY), tr=worldToScreen(b.maxX,b.minY), br=worldToScreen(b.maxX,b.maxY), bl=worldToScreen(b.minX,b.maxY);
    const center=worldToScreen(c.x,c.y);
    const rotate={ x:center.x + Math.cos(item.rotation||0)*0 - Math.sin(item.rotation||0)*(-(bl.y-tl.y)/2+28), y:center.y + Math.sin(item.rotation||0)*0 + Math.cos(item.rotation||0)*(-(bl.y-tl.y)/2+28) };
    return { tl,tr,br,bl,center,w:tr.x-tl.x,h:bl.y-tl.y, deleteBtn:{x:tr.x+14,y:tr.y-14,r:11}, rotateBtn:rotate,
      handles:{tl:{x:tl.x,y:tl.y,r:7},tr:{x:tr.x,y:tr.y,r:7},br:{x:br.x,y:br.y,r:7},bl:{x:bl.x,y:bl.y,r:7}} };
  }

  function hitTestItemHandles(item,sx,sy) {
    const box=getItemScreenBox(item);
    if (Math.hypot(sx-box.deleteBtn.x,sy-box.deleteBtn.y)<=box.deleteBtn.r+6) return {type:'delete'};
    if (Math.hypot(sx-box.rotateBtn.x,sy-box.rotateBtn.y)<=10) return {type:'rotate',center:box.center};
    for (const key of ['tl','tr','br','bl']) if (Math.hypot(sx-box.handles[key].x,sy-box.handles[key].y)<=13) return {type:'resize',center:box.center};
    if (sx>=box.tl.x-8 && sx<=box.tr.x+8 && sy>=box.tl.y-8 && sy<=box.bl.y+8) return {type:'move',center:box.center};
    return null;
  }

  function pointInItem(item,wx,wy,extraPad=null) {
    const c=getItemCenter(item), r=-(item.rotation||0), dx=wx-c.x, dy=wy-c.y;
    const x=dx*Math.cos(r)-dy*Math.sin(r)+c.x, y=dx*Math.sin(r)+dy*Math.cos(r)+c.y, b=getItemBounds(item), pad=extraPad === null ? 12/state.view.scale : extraPad;
    if (item.type==='path') {
      const pts=item.points || [];
      for (let i=0;i<pts.length;i++) {
        if (Math.hypot(pts[i].x-x,pts[i].y-y)<=pad+item.size/2) return true;
        if (i && distanceToSegment(x,y,pts[i-1].x,pts[i-1].y,pts[i].x,pts[i].y)<=pad+item.size/2) return true;
      }
      return false;
    }
    if (item.type==='circle') { const rx=Math.max(item.rx,1)+pad, ry=Math.max(item.ry,1)+pad; const d=((x-item.cx)/rx)**2+((y-item.cy)/ry)**2; return d<=1.15 && d>=0.35; }
    if (item.type==='arrow') return distanceToSegment(x,y,item.x1,item.y1,item.x2,item.y2)<=pad+item.size*2;
    return x>=b.minX-pad && x<=b.maxX+pad && y>=b.minY-pad && y<=b.maxY+pad;
  }

  function distanceToSegment(px,py,x1,y1,x2,y2) { const dx=x2-x1,dy=y2-y1,t=Math.max(0,Math.min(1,((px-x1)*dx+(py-y1)*dy)/(dx*dx+dy*dy||1))); return Math.hypot(px-(x1+t*dx),py-(y1+t*dy)); }
  function hitTestAnyItem(wx,wy) { const cur=state.images[state.currentIndex]; if(!cur) return null; for(let i=cur.annotations.length-1;i>=0;i--) if(pointInItem(cur.annotations[i],wx,wy)) return cur.annotations[i]; return null; }
  function hitTestAnyStamp(wx,wy) { const cur=state.images[state.currentIndex]; if(!cur) return null; for(let i=cur.annotations.length-1;i>=0;i--) { const item=cur.annotations[i]; if(item.type==='stamp' && pointInItem(item,wx,wy)) return item; } return null; }
  function hitTestEraser(wx,wy) { const cur=state.images[state.currentIndex]; if(!cur) return null; const pad=state.eraserSize/(2*state.view.scale); for(let i=cur.annotations.length-1;i>=0;i--) if(pointInItem(cur.annotations[i],wx,wy,pad)) return cur.annotations[i]; return null; }
  function snapshotItemGeometry(item) { return JSON.parse(JSON.stringify(item)); }
  function moveItemByDelta(item, orig, dx, dy) {
    if (item.type === 'circle') { item.cx=orig.cx+dx; item.cy=orig.cy+dy; }
    else if (item.type === 'arrow') { item.x1=orig.x1+dx; item.y1=orig.y1+dy; item.x2=orig.x2+dx; item.y2=orig.y2+dy; }
    else if (item.type === 'path') { item.points=orig.points.map(p=>({x:p.x+dx,y:p.y+dy})); }
    else { item.x=orig.x+dx; item.y=orig.y+dy; }
  }

  function applyItemScale(item,orig,factor) {
    const c=getItemCenter(orig);
    if (item.type==='stamp') item.scale=Math.min(8,Math.max(.15,(orig.scale||1)*factor));
    else if (item.type==='rect') { item.x=c.x-(orig.width*factor)/2; item.y=c.y-(orig.height*factor)/2; item.width=orig.width*factor; item.height=orig.height*factor; }
    else if (item.type==='circle') { item.cx=c.x; item.cy=c.y; item.rx=Math.max(1,orig.rx*factor); item.ry=Math.max(1,orig.ry*factor); }
    else if (item.type==='arrow') { item.x1=c.x+(orig.x1-c.x)*factor; item.y1=c.y+(orig.y1-c.y)*factor; item.x2=c.x+(orig.x2-c.x)*factor; item.y2=c.y+(orig.y2-c.y)*factor; item.size=Math.max(1,orig.size*factor); }
    else if (item.type==='text') { item.x=c.x+(orig.x-c.x)*factor; item.y=c.y+(orig.y-c.y)*factor; item.size=Math.max(8,orig.size*factor); }
    else if (item.type==='path') { item.points=orig.points.map(p=>({x:c.x+(p.x-c.x)*factor,y:c.y+(p.y-c.y)*factor})); item.size=Math.max(1,orig.size*factor); }
  }

  function drawSelectionBox(targetCtx,item) {
    const box=getItemScreenBox(item); targetCtx.save();
    targetCtx.fillStyle='rgba(49,130,206,.08)'; targetCtx.fillRect(box.tl.x,box.tl.y,box.w,box.h);
    targetCtx.strokeStyle='#3182ce'; targetCtx.lineWidth=1.5; targetCtx.setLineDash([4,4]); targetCtx.strokeRect(box.tl.x,box.tl.y,box.w,box.h); targetCtx.setLineDash([]);
    ['tl','tr','br','bl'].forEach(k=>{const h=box.handles[k];targetCtx.beginPath();targetCtx.arc(h.x,h.y,h.r,0,Math.PI*2);targetCtx.fillStyle='#fff';targetCtx.fill();targetCtx.strokeStyle='#3182ce';targetCtx.lineWidth=2;targetCtx.stroke();});
    targetCtx.strokeStyle='#3182ce'; targetCtx.beginPath(); targetCtx.moveTo((box.tl.x+box.tr.x)/2,box.tl.y); targetCtx.lineTo(box.rotateBtn.x,box.rotateBtn.y); targetCtx.stroke();
    targetCtx.beginPath();targetCtx.arc(box.rotateBtn.x,box.rotateBtn.y,8,0,Math.PI*2);targetCtx.fillStyle='#3182ce';targetCtx.fill();
    const btn=box.deleteBtn; targetCtx.beginPath();targetCtx.arc(btn.x,btn.y,btn.r,0,Math.PI*2);targetCtx.fillStyle='#e53e3e';targetCtx.fill();targetCtx.strokeStyle='#fff';targetCtx.lineWidth=2;targetCtx.beginPath();targetCtx.moveTo(btn.x-4,btn.y-4);targetCtx.lineTo(btn.x+4,btn.y+4);targetCtx.moveTo(btn.x+4,btn.y-4);targetCtx.lineTo(btn.x-4,btn.y+4);targetCtx.stroke(); targetCtx.restore();
  }

  function updateSelectedStampUI() {
    if (dom.selectedStampOps) {
      dom.selectedStampOps.style.display = state.selectedItem ? 'flex' : 'none';
      const label = dom.selectedStampOps.querySelector('.prop-label');
      if (label) label.textContent = state.selectedItem ? `选中${getItemTypeLabel(state.selectedItem)}` : '选中图元';
    }
  }

  function getItemTypeLabel(item) {
    return ({ stamp: '印章', rect: '框选', circle: '圆圈', arrow: '箭头', text: '文字', path: '笔迹' }[item.type] || '图元');
  }

  function deleteSelectedItem() {
    const cur = state.images[state.currentIndex];
    if (!cur || !state.selectedItem) return;
    pushUndo();
    const label = getItemTypeLabel(state.selectedItem);
    cur.annotations = cur.annotations.filter(i => i !== state.selectedItem);
    state.selectedItem = null;
    updateSelectedStampUI();
    render();
    showToast(`已清除${label}`);
  }
  function generateMergedCanvas() {
    const cur = state.images[state.currentIndex];
    if (!cur) return null;

    // 创建离屏 Canvas，宽高完全等于图片原始分辨率
    const offCanvas = document.createElement('canvas');
    offCanvas.width = cur.img.naturalWidth;
    offCanvas.height = cur.img.naturalHeight;
    const offCtx = offCanvas.getContext('2d');

    // 1. 绘制底图
    offCtx.drawImage(cur.img, 0, 0);

    // 2. 绘制所有矢量批注（荧光笔统一合成，避免叠加）
    cur.annotations.filter(item => !item.isHighlighter).forEach(item => drawAnnotationItem(offCtx, item));
    const highlighters = cur.annotations.filter(item => item.isHighlighter);
    if (highlighters.length) {
      const layer = document.createElement('canvas');
      layer.width = offCanvas.width;
      layer.height = offCanvas.height;
      const layerCtx = layer.getContext('2d');
      highlighters.forEach(item => drawAnnotationItem(layerCtx, item, { flatHighlighter: true }));
      offCtx.save();
      offCtx.globalAlpha = 0.35;
      offCtx.drawImage(layer, 0, 0);
      offCtx.restore();
    }

    return offCanvas;
  }

  function exportMergedImage() {
    const cur = state.images[state.currentIndex];
    if (!cur) {
      showToast('请先导入作业图片');
      return;
    }

    const offCanvas = generateMergedCanvas();
    if (!offCanvas) return;

    offCanvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const timestamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
      const cleanName = cur.name.replace(/\.[^/.]+$/, '');
      a.download = `批改_${cleanName}_${timestamp}.png`;
      a.href = url;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast('批改图已导出 (高清无损)');
    }, 'image/png');
  }

  function copyMergedImageToClipboard() {
    const cur = state.images[state.currentIndex];
    if (!cur) {
      showToast('请先导入作业图片');
      return;
    }

    const offCanvas = generateMergedCanvas();
    if (!offCanvas) return;

    offCanvas.toBlob((blob) => {
      if (!blob) return;
      if (navigator.clipboard && navigator.clipboard.write) {
        navigator.clipboard.write([
          new ClipboardItem({ 'image/png': blob })
        ]).then(() => {
          showToast('批阅图已复制到剪贴板！');
        }).catch((err) => {
          console.error(err);
          showToast('复制失败，请直接使用导出按钮');
        });
      } else {
        showToast('当前浏览器环境不支持直接写入剪贴板，请使用导出');
      }
    }, 'image/png');
  }

  // ==================== 提示组件 ====================
  function showToast(message) {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    dom.toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(-8px)';
      toast.style.transition = 'all 0.25s ease';
      setTimeout(() => toast.remove(), 250);
    }, 2400);
  }

  // 启动
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
