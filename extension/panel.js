const MCP_SELECTION_ENDPOINT = 'http://127.0.0.1:43017/user-selection';
const MCP_EDIT_ENDPOINT = 'http://127.0.0.1:43017/user-edit';

const shareButton = document.getElementById('share');
const enableEditButton = document.getElementById('enable-edit');
const disableEditButton = document.getElementById('disable-edit');
const attachSelectionButton = document.getElementById('attach-selection');
const colorPicker = document.getElementById('color-picker');
const applyColorButton = document.getElementById('apply-color');
const saveEditsButton = document.getElementById('save-edits');
const statusEl = document.getElementById('status');
const previewEl = document.getElementById('preview');

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.style.color = isError ? '#d93025' : '#202124';
}

function setPreview(value) {
  previewEl.value = value ?? '';
}

function evalInInspectedWindow(expression) {
  return new Promise((resolve, reject) => {
    chrome.devtools.inspectedWindow.eval(
      expression,
      {useContentScriptContext: true},
      (result, exceptionInfo) => {
        if (exceptionInfo) {
          reject(new Error(exceptionInfo.value || 'Evaluation failed'));
          return;
        }
        resolve(result);
      },
    );
  });
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(payload),
    cache: 'no-store',
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Server responded with ${response.status} ${text}`);
  }
}

const COLLECT_SNIPPET = "(() => {\n  const el = $0;\n  if (!el || !(el instanceof Element)) {\n    return null;\n  }\n\n  const toCssPath = element => {\n    if (!element || element.nodeType !== Node.ELEMENT_NODE) {\n      return '';\n    }\n    const segments = [];\n    let current = element;\n    while (current && current.nodeType === Node.ELEMENT_NODE) {\n      let selector = current.nodeName.toLowerCase();\n      if (current.id) {\n        selector += '#' + current.id;\n        segments.unshift(selector);\n        break;\n      }\n      let sibling = current;\n      let index = 1;\n      while ((sibling = sibling.previousElementSibling)) {\n        if (sibling.nodeName === current.nodeName) {\n          index++;\n        }\n      }\n      selector += ':nth-of-type(' + index + ')';\n      segments.unshift(selector);\n      current = current.parentElement;\n    }\n    return segments.join(' > ');\n  };\n\n  const rect = el.getBoundingClientRect();\n  const attributes = {};\n  if (el.attributes) {\n    for (const attr of Array.from(el.attributes)) {\n      attributes[attr.name] = attr.value;\n    }\n  }\n\n  const dataset = {};\n  for (const key of Object.keys(el.dataset || {})) {\n    dataset[key] = el.dataset[key];\n  }\n\n  const html = el.outerHTML || '';\n  const maxPreviewLength = 4000;\n\n  return {\n    pageUrl: location.href,\n    timestamp: Date.now(),\n    selection: {\n      tagName: el.tagName,\n      cssPath: toCssPath(el),\n      textContent: el.textContent?.slice(0, maxPreviewLength) ?? null,\n      innerText: el.innerText?.slice(0, maxPreviewLength) ?? null,\n      outerHTML: html.length > maxPreviewLength ? html.slice(0, maxPreviewLength) + '\\n\u2026' : html,\n      attributes,\n      dataset,\n      boundingClientRect: {\n        x: rect.x,\n        y: rect.y,\n        width: rect.width,\n        height: rect.height,\n        top: rect.top,\n        right: rect.right,\n        bottom: rect.bottom,\n        left: rect.left\n      }\n    }\n  };\n})()";
const EDITOR_BOOTSTRAP_SNIPPET = "(() => {\n  if (window.__mcpVisualEditor) {\n    return 'ready';\n  }\n\n  (function () {\n    const MAX_HISTORY = 100;\n    const HANDLE_DEFS = [\n      {name: 'nw', cursor: 'nwse-resize', left: '-6px', top: '-6px'},\n      {name: 'ne', cursor: 'nesw-resize', right: '-6px', top: '-6px'},\n      {name: 'sw', cursor: 'nesw-resize', left: '-6px', bottom: '-6px'},\n      {name: 'se', cursor: 'nwse-resize', right: '-6px', bottom: '-6px'}\n    ];\n\n    const state = {\n      active: false,\n      target: null,\n      overlay: null,\n      moveHandle: null,\n      handleElements: [],\n      updates: [],\n      currentAction: null,\n      startPointer: null,\n      startRect: null,\n      startDocPosition: null,\n      scrollHandler: null,\n    };\n\n    const cssPath = element => {\n      if (!element || element.nodeType !== Node.ELEMENT_NODE) {\n        return '';\n      }\n      const segments = [];\n      let current = element;\n      while (current && current.nodeType === Node.ELEMENT_NODE) {\n        let selector = current.nodeName.toLowerCase();\n        if (current.id) {\n          selector += '#' + current.id;\n          segments.unshift(selector);\n          break;\n        }\n        let sibling = current;\n        let index = 1;\n        while ((sibling = sibling.previousElementSibling)) {\n          if (sibling.nodeName === current.nodeName) {\n            index++;\n          }\n        }\n        selector += ':nth-of-type(' + index + ')';\n        segments.unshift(selector);\n        current = current.parentElement;\n      }\n      return segments.join(' > ');\n    };\n\n    const snapshot = element => {\n      if (!element || !(element instanceof Element)) {\n        return null;\n      }\n      const rect = element.getBoundingClientRect();\n      const styles = window.getComputedStyle(element);\n      return {\n        cssPath: cssPath(element),\n        tagName: element.tagName,\n        boundingClientRect: {\n          x: rect.x,\n          y: rect.y,\n          width: rect.width,\n          height: rect.height,\n          top: rect.top,\n          right: rect.right,\n          bottom: rect.bottom,\n          left: rect.left,\n        },\n        inlineStyles: {\n          position: element.style.position || '',\n          left: element.style.left || '',\n          top: element.style.top || '',\n          width: element.style.width || styles.width,\n          height: element.style.height || styles.height,\n          backgroundColor: element.style.backgroundColor || styles.backgroundColor,\n          color: element.style.color || styles.color,\n        },\n        outerHTML: (element.outerHTML || '').slice(0, 4000),\n      };\n    };\n\n    const ensureOverlay = () => {\n      if (state.overlay) {\n        return state.overlay;\n      }\n      const overlay = document.createElement('div');\n      overlay.className = '__mcp-visual-overlay';\n      Object.assign(overlay.style, {\n        position: 'fixed',\n        border: '2px solid #1a73e8',\n        background: 'rgba(26,115,232,0.08)',\n        zIndex: '2147483646',\n        pointerEvents: 'none',\n        boxSizing: 'border-box',\n      });\n\n      const moveHandle = document.createElement('div');\n      Object.assign(moveHandle.style, {\n        position: 'absolute',\n        left: '0',\n        top: '0',\n        right: '0',\n        bottom: '0',\n        cursor: 'move',\n        pointerEvents: 'auto',\n        background: 'transparent',\n      });\n      overlay.appendChild(moveHandle);\n      state.moveHandle = moveHandle;\n\n      state.handleElements = HANDLE_DEFS.map(def => {\n        const handle = document.createElement('div');\n        handle.dataset.handle = def.name;\n        Object.assign(handle.style, {\n          position: 'absolute',\n          width: '10px',\n          height: '10px',\n          background: '#1a73e8',\n          borderRadius: '50%',\n          pointerEvents: 'auto',\n          cursor: def.cursor,\n        });\n        if (def.left) handle.style.left = def.left;\n        if (def.right) handle.style.right = def.right;\n        if (def.top) handle.style.top = def.top;\n        if (def.bottom) handle.style.bottom = def.bottom;\n        overlay.appendChild(handle);\n        return handle;\n      });\n\n      document.body.appendChild(overlay);\n      state.overlay = overlay;\n      bindOverlayEvents();\n      return overlay;\n    };\n\n    const bindOverlayEvents = () => {\n      if (!state.overlay || !state.moveHandle) {\n        return;\n      }\n      state.moveHandle.addEventListener('pointerdown', event => {\n        startAction('move', event, null);\n      });\n      state.handleElements.forEach(handle => {\n        handle.addEventListener('pointerdown', event => {\n          startAction('resize', event, handle.dataset.handle || '');\n        });\n      });\n    };\n\n    const attachScrollHandler = () => {\n      if (state.scrollHandler) {\n        return;\n      }\n      state.scrollHandler = () => {\n        if (!state.active || !state.target) {\n          return;\n        }\n        updateOverlay();\n      };\n      window.addEventListener('scroll', state.scrollHandler, true);\n      window.addEventListener('resize', state.scrollHandler);\n    };\n\n    const detachScrollHandler = () => {\n      if (!state.scrollHandler) {\n        return;\n      }\n      window.removeEventListener('scroll', state.scrollHandler, true);\n      window.removeEventListener('resize', state.scrollHandler);\n      state.scrollHandler = null;\n    };\n\n    const updateOverlay = () => {\n      if (!state.overlay || !state.target || !state.active) {\n        if (state.overlay) {\n          state.overlay.style.display = 'none';\n        }\n        return;\n      }\n      const rect = state.target.getBoundingClientRect();\n      const overlay = state.overlay;\n      overlay.style.display = 'block';\n      overlay.style.left = rect.left + 'px';\n      overlay.style.top = rect.top + 'px';\n      overlay.style.width = Math.max(rect.width, 2) + 'px';\n      overlay.style.height = Math.max(rect.height, 2) + 'px';\n    };\n\n    const applyLayout = (left, top, width, height) => {\n      const el = state.target;\n      if (!el) {\n        return;\n      }\n      const computed = window.getComputedStyle(el);\n      if (computed.position === 'static') {\n        el.style.position = 'absolute';\n      }\n      if (computed.display === 'inline') {\n        el.style.display = 'inline-block';\n      }\n      el.style.left = left.toFixed(1) + 'px';\n      el.style.top = top.toFixed(1) + 'px';\n      el.style.width = width.toFixed(1) + 'px';\n      el.style.height = height.toFixed(1) + 'px';\n      el.style.right = '';\n      el.style.bottom = '';\n      el.style.margin = '0';\n    };\n\n    const recordChange = summary => {\n      if (!state.target) {\n        return;\n      }\n      const info = snapshot(state.target);\n      if (!info) {\n        return;\n      }\n      state.updates.push({\n        capturedAt: Date.now(),\n        pageUrl: window.location.href,\n        cssPath: info.cssPath,\n        tagName: info.tagName,\n        styles: info.inlineStyles,\n        summary,\n      });\n      if (state.updates.length > MAX_HISTORY) {\n        state.updates.shift();\n      }\n    };\n\n    const startAction = (type, event, direction) => {\n      if (!state.target) {\n        return;\n      }\n      event.preventDefault();\n      event.stopPropagation();\n      state.currentAction = {\n        type,\n        direction: direction || '',\n        pointerId: event.pointerId,\n      };\n      state.startPointer = {x: event.clientX, y: event.clientY};\n      const rect = state.target.getBoundingClientRect();\n      state.startRect = rect;\n      state.startDocPosition = {\n        left: rect.left + window.scrollX,\n        top: rect.top + window.scrollY,\n      };\n      event.target.setPointerCapture(event.pointerId);\n      window.addEventListener('pointermove', onPointerMove);\n      window.addEventListener('pointerup', onPointerUp);\n    };\n\n    const onPointerMove = event => {\n      if (!state.currentAction || !state.target || !state.startRect || !state.startPointer || !state.startDocPosition) {\n        return;\n      }\n      const dx = event.clientX - state.startPointer.x;\n      const dy = event.clientY - state.startPointer.y;\n      if (state.currentAction.type === 'move') {\n        const newLeft = state.startDocPosition.left + dx;\n        const newTop = state.startDocPosition.top + dy;\n        applyLayout(newLeft, newTop, state.startRect.width, state.startRect.height);\n      } else {\n        const dir = state.currentAction.direction;\n        let newLeft = state.startDocPosition.left;\n        let newTop = state.startDocPosition.top;\n        let newWidth = state.startRect.width;\n        let newHeight = state.startRect.height;\n\n        if (dir.indexOf('e') !== -1) {\n          newWidth = Math.max(20, state.startRect.width + dx);\n        }\n        if (dir.indexOf('s') !== -1) {\n          newHeight = Math.max(20, state.startRect.height + dy);\n        }\n        if (dir.indexOf('w') !== -1) {\n          newWidth = Math.max(20, state.startRect.width - dx);\n          newLeft = state.startDocPosition.left + dx;\n        }\n        if (dir.indexOf('n') !== -1) {\n          newHeight = Math.max(20, state.startRect.height - dy);\n          newTop = state.startDocPosition.top + dy;\n        }\n        applyLayout(newLeft, newTop, newWidth, newHeight);\n      }\n      updateOverlay();\n    };\n\n    const onPointerUp = event => {\n      if (state.currentAction && event.pointerId === state.currentAction.pointerId) {\n        try {\n          event.target.releasePointerCapture(state.currentAction.pointerId);\n        } catch (e) {}\n      }\n      window.removeEventListener('pointermove', onPointerMove);\n      window.removeEventListener('pointerup', onPointerUp);\n      if (state.currentAction) {\n        const summary = state.currentAction.type === 'move'\n          ? 'Move element'\n          : 'Resize ' + state.currentAction.direction;\n        recordChange(summary);\n      }\n      state.currentAction = null;\n    };\n\n    const selectTarget = element => {\n      if (!element || !(element instanceof Element)) {\n        state.target = null;\n        if (state.overlay) {\n          state.overlay.style.display = 'none';\n        }\n        return null;\n      }\n      ensureOverlay();\n      state.target = element;\n      state.active = true;\n      attachScrollHandler();\n      updateOverlay();\n      return snapshot(element);\n    };\n\n    const setStyle = (element, styles) => {\n      if (!element || !(element instanceof Element)) {\n        return null;\n      }\n      ensureOverlay();\n      for (const key in styles) {\n        if (Object.prototype.hasOwnProperty.call(styles, key)) {\n          element.style[key] = styles[key];\n        }\n      }\n      if (element === state.target) {\n        updateOverlay();\n      }\n      recordChange('Style update');\n      return snapshot(element);\n    };\n\n    const flushChanges = () => {\n      const payload = {\n        pageUrl: window.location.href,\n        edits: state.updates.slice(),\n      };\n      state.updates.length = 0;\n      return payload;\n    };\n\n    const disable = () => {\n      state.active = false;\n      state.target = null;\n      if (state.overlay && state.overlay.parentElement) {\n        state.overlay.parentElement.removeChild(state.overlay);\n      }\n      state.overlay = null;\n      state.moveHandle = null;\n      state.handleElements = [];\n      detachScrollHandler();\n      return true;\n    };\n\n    window.__mcpVisualEditor = {\n      enable() {\n        state.active = true;\n        ensureOverlay();\n        attachScrollHandler();\n        updateOverlay();\n        return true;\n      },\n      disable,\n      selectCurrent(element) {\n        return selectTarget(element);\n      },\n      setStyle(element, styles) {\n        return setStyle(element, styles || {});\n      },\n      flushChanges,\n    };\n  })();\n\n  return 'installed';\n})()";

async function ensureEditorInstalled() {
  await evalInInspectedWindow(EDITOR_BOOTSTRAP_SNIPPET);
}

async function handleShareSelection() {
  setStatus('Collecting element details...');
  shareButton.disabled = true;
  try {
    const result = await evalInInspectedWindow(COLLECT_SNIPPET);
    if (!result) {
      throw new Error('No element is currently selected in the Elements panel.');
    }
    setPreview(JSON.stringify(result, null, 2));
    setStatus('Sending selection to MCP server...');
    await postJson(MCP_SELECTION_ENDPOINT, result);
    setStatus('Selection shared with MCP server.');
  } catch (error) {
    console.error(error);
    setStatus(error instanceof Error ? error.message : String(error), true);
  } finally {
    shareButton.disabled = false;
  }
}

async function handleEnableEdit() {
  try {
    setStatus('Enabling edit overlay...');
    await ensureEditorInstalled();
    await evalInInspectedWindow('window.__mcpVisualEditor.enable();');
    setStatus('Edit overlay enabled. Drag handles on the page to move or resize elements.');
  } catch (error) {
    console.error(error);
    setStatus(error instanceof Error ? error.message : String(error), true);
  }
}

async function handleDisableEdit() {
  try {
    await ensureEditorInstalled();
    await evalInInspectedWindow('window.__mcpVisualEditor.disable();');
    setStatus('Edit overlay disabled.');
  } catch (error) {
    console.error(error);
    setStatus(error instanceof Error ? error.message : String(error), true);
  }
}

async function handleAttachSelection() {
  try {
    await ensureEditorInstalled();
    const info = await evalInInspectedWindow('window.__mcpVisualEditor.selectCurrent($0);');
    if (!info) {
      throw new Error('Select an element in the Elements panel before attaching the overlay.');
    }
    setPreview(JSON.stringify(info, null, 2));
    setStatus('Overlay attached to selected element.');
  } catch (error) {
    console.error(error);
    setStatus(error instanceof Error ? error.message : String(error), true);
  }
}

async function handleApplyColor() {
  try {
    const color = colorPicker.value;
    await ensureEditorInstalled();
    const expression = `window.__mcpVisualEditor.setStyle($0, {{ backgroundColor: '${color}' }});`;
    const info = await evalInInspectedWindow(expression);
    if (info) {
      setPreview(JSON.stringify(info, null, 2));
    }
    setStatus(`Applied background color ${color}.`);
  } catch (error) {
    console.error(error);
    setStatus(error instanceof Error ? error.message : String(error), true);
  }
}

async function handleSaveEdits() {
  saveEditsButton.disabled = true;
  try {
    await ensureEditorInstalled();
    const edits = await evalInInspectedWindow('window.__mcpVisualEditor.flushChanges();');
    if (!edits || !Array.isArray(edits.edits) || edits.edits.length === 0) {
      setStatus('No pending edits to save.');
      return;
    }
    setPreview(JSON.stringify(edits, null, 2));
    await postJson(MCP_EDIT_ENDPOINT, edits);
    setStatus(`Saved ${edits.edits.length} edit(s) to MCP server.`);
  } catch (error) {
    console.error(error);
    setStatus(error instanceof Error ? error.message : String(error), true);
  } finally {
    saveEditsButton.disabled = false;
  }
}

shareButton.addEventListener('click', handleShareSelection);
enableEditButton.addEventListener('click', handleEnableEdit);
disableEditButton.addEventListener('click', handleDisableEdit);
attachSelectionButton.addEventListener('click', handleAttachSelection);
applyColorButton.addEventListener('click', handleApplyColor);
saveEditsButton.addEventListener('click', handleSaveEdits);

setStatus('Ready. Select an element in the Elements panel to begin.');
