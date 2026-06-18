// ================= Webview frontend render template =================
export function getWebviewContent() {
    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>CodeGraph</title>
        <style>
            body {
                padding: 0; margin: 0; width: 100vw; height: 100vh;
                background-color: var(--vscode-editor-background);
                color: var(--vscode-editor-foreground);
                overflow: hidden;
            }
            #mountNode { width: 100%; height: 100%; display: flex; justify-content: center; align-items: center; }

            /* Context menu */
            #ctxMenu {
                display: none;
                position: absolute; z-index: 1000;
                background: var(--vscode-menu-background, #252526);
                border: 1px solid var(--vscode-menu-border, #454545);
                border-radius: 4px; padding: 4px 0; min-width: 130px;
                box-shadow: 0 4px 12px rgba(0,0,0,0.4);
            }
            .ctx-item {
                padding: 6px 16px; cursor: pointer; font-size: 12px;
                color: var(--vscode-menu-foreground, #CCC); white-space: nowrap;
            }
            .ctx-item:hover { background: var(--vscode-menu-selectionBackground, #094771); }

            /* Toolbar */
            #toolbar {
                position: absolute;
                top: 20px;
                right: 20px;
                z-index: 999;
                display: flex;
                align-items: center;
                gap: 6px;
                background-color: var(--vscode-editorWidget-background);
                padding: 6px;
                border: 1px solid var(--vscode-editorWidget-border);
                border-radius: 4px;
                box-shadow: 0 2px 8px rgba(0,0,0,0.15);
            }
            .tool-btn {
                background-color: var(--vscode-button-background);
                color: var(--vscode-button-foreground);
                border: none;
                padding: 4px 10px;
                border-radius: 2px;
                cursor: pointer;
                font-size: 12px;
                line-height: 1;
            }
            .tool-btn:hover { background-color: var(--vscode-button-hoverBackground); }
            .tool-btn:disabled {
                opacity: 0.5;
                cursor: not-allowed;
                background-color: var(--vscode-button-secondaryBackground);
                color: var(--vscode-button-secondaryForeground);
            }
            .tool-sep {
                width: 1px; height: 20px;
                background: var(--vscode-editorWidget-border, #454545);
                margin: 0 2px;
            }
            .stale-badge {
                display: none;
                background: #D4A017; color: #000;
                font-size: 10px; font-weight: bold;
                padding: 2px 6px; border-radius: 3px;
                line-height: 1;
            }
            .stale-badge.visible { display: inline-block; }
            #btn-refresh { font-weight: bold; }
        </style>
        <script src="https://unpkg.com/@antv/g6@4.8.24/dist/g6.min.js"></script>
    </head>
    <body>
        <div id="toolbar" style="display: none;">
            <button id="btn-undo" class="tool-btn" disabled title="Go back one step">Undo</button>
            <button id="btn-redo" class="tool-btn" disabled title="Redo">Redo</button>
            <button id="btn-reset" class="tool-btn" title="Back to initial state">Reset</button>
            <span class="tool-sep"></span>
            <span id="stale-badge" class="stale-badge" title="File changes detected — graph may be out of date">&#9888; Outdated</span>
            <button id="btn-refresh" class="tool-btn" title="Reload graph from latest indexed data">&#x21bb; Reload</button>
            <span class="tool-sep"></span>
            <button id="btn-zoom-in" class="tool-btn" title="Zoom in">Zoom In</button>
            <button id="btn-zoom-out" class="tool-btn" title="Zoom out">Zoom Out</button>
            <button id="btn-zoom-fit" class="tool-btn" title="Fit to view">Fit</button>
        </div>

        <div id="mountNode">Loading graph...</div>

        <div id="ctxMenu">
            <div class="ctx-item" data-action="source">Source</div>
            <div class="ctx-item" data-action="detail">Detail</div>
            <div class="ctx-item" data-action="copyYml">Copy YAML</div>
            <div class="ctx-item" data-action="copyMd">Copy Markdown Tree</div>
        </div>

        <script>
            const vscode = acquireVsCodeApi();
            let graph = null;
            let currentData = null;
            let ctxNode = null;          // right-click target node
            let expandedNodes = {};      // tracks expanded child node IDs per parent

            // ── History state stacks ──
            let initialSnapshot = null;
            let undoStack = [];
            let redoStack = [];

            // ── State management & toolbar ──
            function cloneState() {
                // Only extract essential fields; G6 injects circular refs (cfg/children/parent) that break JSON.stringify
                const nodes = currentData.nodes.map(n => ({
                    id: n.id, label: n.label, filePath: n.filePath, line: n.line, kind: n.kind,
                    style: n.style ? { ...n.style } : undefined,
                    labelCfg: n.labelCfg ? { style: { ...n.labelCfg.style } } : undefined,
                }));
                const edges = currentData.edges.map(e => ({
                    source: e.source, target: e.target,
                    style: e.style ? { ...e.style } : undefined,
                }));
                return {
                    data: { nodes, edges },
                    expanded: JSON.parse(JSON.stringify(expandedNodes))
                };
            }

            function saveHistory() {
                undoStack.push(cloneState());
                redoStack = [];
                console.log('[saveHistory] undoStack.length=', undoStack.length, ' redoStack.length=', redoStack.length);
                updateToolbarUI();
            }

            function updateToolbarUI() {
                const toolbar = document.getElementById('toolbar');
                if (currentData && currentData.nodes && currentData.nodes.length > 0) {
                    toolbar.style.display = 'flex';
                }
                document.getElementById('btn-undo').disabled = undoStack.length === 0;
                document.getElementById('btn-redo').disabled = redoStack.length === 0;
                console.log('[updateToolbarUI] undoDisabled=', undoStack.length === 0, ' redoDisabled=', redoStack.length === 0);
            }

            function applySnapshot(snapshot) {
                console.log('[applySnapshot] restoring snapshot, nodes=', snapshot.data.nodes.length, ' expandedKeys=', Object.keys(snapshot.expanded).length);
                currentData = snapshot.data;
                expandedNodes = snapshot.expanded;
                const theme = getBaseTheme();
                updateGraphTheme(theme);
                // Use data()+render() for full rebuild; changeData is unreliable for incremental snapshots
                graph.data(currentData);
                graph.render();
                graph.fitView(20);
                updateExpandedStyles();
                updateToolbarUI();
            }

            // Bind button events directly (DOMContentLoaded may have already fired in webview)
            function bindToolbarButtons() {
                const btnUndo = document.getElementById('btn-undo');
                const btnRedo = document.getElementById('btn-redo');
                const btnReset = document.getElementById('btn-reset');
                const btnZoomIn = document.getElementById('btn-zoom-in');
                const btnZoomOut = document.getElementById('btn-zoom-out');
                const btnZoomFit = document.getElementById('btn-zoom-fit');
                console.log('[bindToolbarButtons] buttons found:', !!btnUndo, !!btnRedo, !!btnReset, !!btnZoomIn, !!btnZoomOut, !!btnZoomFit);

                btnUndo && btnUndo.addEventListener('click', () => {
                    if (undoStack.length === 0) return;
                    redoStack.push(cloneState());
                    const prevState = undoStack.pop();
                    applySnapshot(prevState);
                });

                btnRedo && btnRedo.addEventListener('click', () => {
                    if (redoStack.length === 0) return;
                    undoStack.push(cloneState());
                    const nextState = redoStack.pop();
                    applySnapshot(nextState);
                });

                btnReset && btnReset.addEventListener('click', () => {
                    if (!initialSnapshot) return;
                    // True reset: clear undo/redo, restore initial state directly
                    undoStack = [];
                    redoStack = [];
                    currentData = JSON.parse(JSON.stringify(initialSnapshot.data));
                    expandedNodes = JSON.parse(JSON.stringify(initialSnapshot.expanded));
                    const theme = getBaseTheme();
                    updateGraphTheme(theme);
                    graph.data(currentData);
                    graph.render();
                    graph.fitView(20);
                    updateExpandedStyles();
                    updateToolbarUI();
                });

                btnZoomIn && btnZoomIn.addEventListener('click', () => {
                    if (!graph) return;
                    const currentZoom = graph.getZoom();
                    graph.zoomTo(Math.min(currentZoom * 1.3, 5), { x: graph.getWidth() / 2, y: graph.getHeight() / 2 });
                });

                btnZoomOut && btnZoomOut.addEventListener('click', () => {
                    if (!graph) return;
                    const currentZoom = graph.getZoom();
                    graph.zoomTo(Math.max(currentZoom / 1.3, 0.1), { x: graph.getWidth() / 2, y: graph.getHeight() / 2 });
                });

                btnZoomFit && btnZoomFit.addEventListener('click', () => {
                    if (!graph) return;
                    graph.fitView(20);
                });

                const btnRefresh = document.getElementById('btn-refresh');
                btnRefresh && btnRefresh.addEventListener('click', () => {
                    vscode.postMessage({ command: 'refreshGraph' });
                });
            }
            bindToolbarButtons();

            // ── Theme ──
            function getBaseTheme() {
                const isLight = document.body.classList.contains('vscode-light');
                return {
                    isLight,
                    edgeStroke: isLight ? '#A3A3A3' : '#666666',
                    centerNodeFill: isLight ? '#007ACC' : '#005A9E',
                    centerNodeLabel: '#FFFFFF',
                    defaultFill: isLight ? '#F3F3F3' : '#2D2D30',
                    defaultStroke: isLight ? '#CECECE' : '#555555',
                    defaultLabel: isLight ? '#333333' : '#D4D4D4'
                };
            }

            function getStyleByKind(kind, theme) {
                const kindPalette = {
                    'class': { fill: theme.isLight ? '#E8DFF5' : '#4B326B', stroke: theme.isLight ? '#C3A5E4' : '#6A4A93' },
                    'interface': { fill: theme.isLight ? '#D1E7DD' : '#1E3A2F', stroke: theme.isLight ? '#A3D0B6' : '#2E5A48' },
                    'method': { fill: theme.isLight ? '#FFF3CD' : '#4D4119', stroke: theme.isLight ? '#FFE69C' : '#756429' },
                    'function': { fill: theme.isLight ? '#FCE4EC' : '#6A1B38', stroke: theme.isLight ? '#F48FB1' : '#AD1457' },
                    'file': { fill: theme.isLight ? '#FAD7A1' : '#784212', stroke: theme.isLight ? '#F5B041' : '#E67E22' },
                    'field': { fill: theme.isLight ? '#CCFBF1' : '#115E59', stroke: theme.isLight ? '#5EEAD4' : '#0F766E' },
                    'property': { fill: theme.isLight ? '#E0E7FF' : '#312E81', stroke: theme.isLight ? '#A5B4FC' : '#4338CA' },
                    'import': { fill: theme.isLight ? '#E2E8F0' : '#334155', stroke: theme.isLight ? '#94A3B8' : '#475569' }
                };
                const safeKind = kind ? kind.toLowerCase() : 'unknown';
                const cfg = kindPalette[safeKind];
                return {
                    fill: cfg ? cfg.fill : theme.defaultFill,
                    stroke: cfg ? cfg.stroke : theme.defaultStroke,
                    labelFill: theme.defaultLabel
                };
            }

            // ── Close context menu ──
            function hideCtxMenu() {
                document.getElementById('ctxMenu').style.display = 'none';
                ctxNode = null;
            }

            function showCtxMenu(x, y, isNode) {
                const menu = document.getElementById('ctxMenu');
                document.querySelector('[data-action="source"]').style.display = isNode ? '' : 'none';
                document.querySelector('[data-action="detail"]').style.display = isNode ? '' : 'none';
                document.querySelector('[data-action="copyYml"]').style.display = isNode ? 'none' : '';
                document.querySelector('[data-action="copyMd"]').style.display = isNode ? 'none' : '';
                menu.style.display = 'block';
                menu.style.left = x + 'px';
                menu.style.top = y + 'px';
            }

            // ── Collapse subtree ──
            function collapseChildren(nodeId) {
                if (!graph) return;
                const childIds = expandedNodes[nodeId];
                if (!childIds || childIds.length === 0) return;

                childIds.forEach(cid => {
                    collapseChildren(cid); // recursively collapse descendants
                    const n = graph.findById(cid);
                    if (n) {
                        graph.removeItem(n);
                        // Sync currentData so undo/redo stays consistent
                        currentData.nodes = currentData.nodes.filter(node => node.id !== cid);
                    }
                });

                // Remove edges from nodeId to children, and sync currentData
                graph.getEdges().forEach(e => {
                    const m = e.getModel();
                    if (m.source === nodeId && childIds.includes(m.target)) {
                        graph.removeItem(e);
                    }
                });
                currentData.edges = currentData.edges.filter(edge => !(edge.source === nodeId && childIds.includes(edge.target)));

                delete expandedNodes[nodeId];
                graph.layout();
                updateExpandedStyles();
            }

            function updateExpandedStyles() {
                if (!graph) return;
                graph.getNodes().forEach(n => {
                    const m = n.getModel();
                    if (expandedNodes[m.id] && expandedNodes[m.id].length > 0) {
                        graph.updateItem(n, {
                            style: { ...m.style, lineWidth: 3, stroke: '#FFA500', shadowColor: '#FFA500', shadowBlur: 8 }
                        });
                    } else {
                        // Reset to default if collapsed
                        graph.updateItem(n, { style: { ...m.style, lineWidth: 1.5, shadowBlur: 0 } });
                    }
                });
            }

            function render(data) {
                currentData = data;
                const container = document.getElementById('mountNode');

                if (!data || !data.nodes || data.nodes.length === 0) {
                    container.innerHTML = 'No nodes found. Check if the selected code has any relationships.';
                    graph = null;
                    return;
                }

                const theme = getBaseTheme();

                // Initialize history snapshot (only for fresh render, not incremental addNodes)
                expandedNodes = {};
                undoStack = [];
                redoStack = [];
                initialSnapshot = cloneState();
                updateToolbarUI();

                if (!graph) {
                    // First render: clear placeholder and create G6 instance
                    container.innerHTML = '';
                    const width = container.scrollWidth || window.innerWidth;
                    const height = container.scrollHeight || window.innerHeight;

                    graph = new G6.Graph({
                        container: 'mountNode',
                        width, height,
                        fitView: true,
                        fitViewPadding: [20, 40, 50, 20],
                        layout: { type: 'dagre', rankdir: 'LR', nodesep: 40, ranksep: 80 },
                        defaultNode: { type: 'rect', size: [140, 40], style: { radius: 6, cursor: 'pointer', lineWidth: 1.5 }, labelCfg: { style: { fontSize: 13 } } },
                        defaultEdge: { type: 'cubic-horizontal', style: { endArrow: true } },
                        modes: { default: ['drag-canvas', 'zoom-canvas', 'drag-node'] }
                    });

                    // Double-click → expand/collapse
                    graph.on('node:dblclick', (evt) => {
                        const model = evt.item.getModel();
                        toggleExpand(model);
                    });

                    // Right-click node → context menu with Source / Detail
                    graph.on('node:contextmenu', (evt) => {
                        evt.preventDefault();
                        evt.stopPropagation();
                        ctxNode = evt.item;
                        showCtxMenu(evt.clientX, evt.clientY, true);
                    });

                    // Right-click canvas → context menu with Copy YAML / Markdown Tree
                    graph.on('canvas:contextmenu', (evt) => {
                        evt.preventDefault();
                        evt.stopPropagation();
                        ctxNode = null;
                        showCtxMenu(evt.clientX, evt.clientY, false);
                    });

                    // Click canvas → close menu
                    graph.on('canvas:click', () => hideCtxMenu());

                    // Resize handler: keep canvas filling the container
                    window.addEventListener('resize', () => {
                        if (!graph) return;
                        const c = document.getElementById('mountNode');
                        const w = c.scrollWidth || window.innerWidth;
                        const h = c.scrollHeight || window.innerHeight;
                        graph.changeSize(w, h);
                        graph.fitView(20);
                    });
                }
                // Refresh: graph already exists, canvas is intact — just swap data

                updateGraphTheme(theme);
                graph.data(data);
                graph.render();
                graph.fitView(20);
            }

            // ── Expand/collapse toggle ──
            function toggleExpand(model) {
                console.log('[toggleExpand] model.id=', model.id, ' label=', model.label, ' expanded=', !!expandedNodes[model.id]);
                if (expandedNodes[model.id] && expandedNodes[model.id].length > 0) {
                    try { saveHistory(); } catch(e) { console.error('[toggleExpand] saveHistory failed:', e); }
                    collapseChildren(model.id);
                } else {
                    vscode.postMessage({ command: 'expandNode', payload: { symbol: model.id } });
                }
            }

            // ── Incrementally add expanded nodes ──
            function addNodes(parentId, nodes, edges) {
                console.log('[addNodes] received parentId=', parentId, ' nodes=', nodes.length, ' edges=', edges.length);
                if (!graph) return;

                try { saveHistory(); } catch(e) { console.error('[addNodes] saveHistory failed:', e); }

                const theme = getBaseTheme();
                const addedIds = [];
                nodes.forEach(n => {
                    if (!graph.findById(n.id)) {
                        const ks = getStyleByKind(n.kind, theme);
                        graph.addItem('node', {
                            ...n,
                            type: 'rect',
                            style: { fill: ks.fill, stroke: ks.stroke, radius: 6, cursor: 'pointer', lineWidth: 1.5 },
                            labelCfg: { style: { fill: ks.labelFill, fontSize: 13 } }
                        });
                        addedIds.push(n.id);
                    }
                });
                edges.forEach(e => {
                    const exists = graph.getEdges().find(
                        ed => ed.getModel().source === e.source && ed.getModel().target === e.target
                    );
                    if (!exists) graph.addItem('edge', { source: e.source, target: e.target, style: { stroke: theme.edgeStroke, endArrow: true } });
                });

                // Track expansion relationship + sync to currentData
                if (!expandedNodes[parentId]) expandedNodes[parentId] = [];
                expandedNodes[parentId].push(...addedIds);
                currentData.nodes.push(...nodes);
                currentData.edges.push(...edges);

                graph.layout();
                updateExpandedStyles();
                setTimeout(() => graph.fitView(20), 100);
            }

            // ── Theme update ──
            function updateGraphTheme(theme) {
                if (!currentData) return;
                currentData.nodes.forEach(node => {
                    const isCenter = node.style && (node.style.fill === '#007ACC' || node.style.fill === '#005A9E');
                    const ks = getStyleByKind(node.kind, theme);
                    node.style = { ...node.style, fill: isCenter ? theme.centerNodeFill : ks.fill, stroke: isCenter ? theme.centerNodeFill : ks.stroke };
                    node.labelCfg = { style: { fill: isCenter ? theme.centerNodeLabel : ks.labelFill } };
                });
                currentData.edges.forEach(edge => {
                    edge.style = { ...edge.style, stroke: theme.edgeStroke };
                });
            }

            // ── YAML export ──
            function buildYaml() {
                if (!currentData) return '';
                var yml = 'nodes:\\n';
                currentData.nodes.forEach(function(n) {
                    yml += '  - id: ' + n.id + '\\n';
                    yml += '    name: ' + n.label + '\\n';
                    yml += '    kind: ' + n.kind + '\\n';
                    yml += '    file: ' + (n.filePath || '') + '\\n';
                    yml += '    line: ' + (n.line || '') + '\\n';
                });
                yml += 'edges:\\n';
                currentData.edges.forEach(function(e) {
                    var srcNode = currentData.nodes.find(function(n) { return n.id === e.source; });
                    var tgtNode = currentData.nodes.find(function(n) { return n.id === e.target; });
                    yml += '  - source: ' + e.source;
                    yml += srcNode ? ' # ' + srcNode.label : '';
                    yml += '\\n';
                    yml += '    target: ' + e.target;
                    yml += tgtNode ? ' # ' + tgtNode.label : '';
                    yml += '\\n';
                });
                return yml;
            }

            // ── Markdown tree export ──
            function buildMarkdownTree() {
                if (!currentData || !currentData.nodes.length) return '';
                // Find root nodes (depth 0 or center-style fill)
                const roots = currentData.nodes.filter(n =>
                    n.style && (n.style.fill === '#007ACC' || n.style.fill === '#005A9E')
                );
                const startNodes = roots.length > 0 ? roots : currentData.nodes.filter(n => n.depth === 0 || !n.depth);
                if (!startNodes.length) return '';

                const visited = new Set();
                function renderTree(nodeId, indent) {
                    if (visited.has(nodeId)) return '';
                    visited.add(nodeId);
                    const node = currentData.nodes.find(n => n.id === nodeId);
                    if (!node) return '';
                    const prefix = '  '.repeat(indent) + '- ';
                    var out = prefix + '**' + node.label + '**';
                    if (node.kind) out += ' _(' + node.kind + ')_';
                    out += '\\n';
                    const children = currentData.edges.filter(e => e.source === nodeId);
                    children.forEach(e => {
                        out += renderTree(e.target, indent + 1);
                    });
                    return out;
                }

                let md = '';
                startNodes.forEach(n => {
                    visited.clear();
                    md += renderTree(n.id, 0);
                });
                return md;
            }

            // ── Context menu click ──
            document.getElementById('ctxMenu').addEventListener('click', (e) => {
                const item = e.target.closest('[data-action]');
                const action = item ? item.getAttribute('data-action') : null;
                const node = ctxNode; // Save before hideCtxMenu clears ctxNode
                hideCtxMenu();
                if (!action) return;
                const model = node ? node.getModel() : null;

                if (action === 'source' && model) {
                    vscode.postMessage({
                        command: 'openFile',
                        payload: { name: model.id, path: model.filePath, line: model.line }
                    });
                }
                if (action === 'detail' && model) {
                    vscode.postMessage({
                        command: 'showDetail',
                        payload: { id: model.id, name: model.label, filePath: model.filePath, line: model.line, kind: model.kind }
                    });
                }
                if (action === 'copyYml') {
                    const text = buildYaml();
                    vscode.postMessage({ command: 'copyToClipboard', payload: { text, label: 'YAML' } });
                }
                if (action === 'copyMd') {
                    const text = buildMarkdownTree();
                    vscode.postMessage({ command: 'copyToClipboard', payload: { text, label: 'Markdown Tree' } });
                }
            });

            // ── Message listener ──
            window.addEventListener('message', event => {
                const msg = event.data;
                if (msg.command === 'renderGraph') {
                    render(msg.data);
                    // Reset stale state on refresh
                    document.getElementById('stale-badge').classList.remove('visible');
                }
                if (msg.command === 'addNodes') {
                    addNodes(msg.data.parentId, msg.data.nodes, msg.data.edges);
                }
                if (msg.command === 'dataStale') {
                    document.getElementById('stale-badge').classList.add('visible');
                }
            });

            // ── VS Code theme switch listener ──
            const observer = new MutationObserver((mutations) => {
                mutations.forEach((mutation) => {
                    if (mutation.attributeName === 'class' && graph && currentData) {
                        const newTheme = getBaseTheme();
                        updateGraphTheme(newTheme);
                        graph.changeData(currentData);
                    }
                });
            });
            observer.observe(document.body, { attributes: true });
        </script>
    </body>
    </html>`;
}
