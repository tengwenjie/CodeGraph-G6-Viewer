// ================= Webview 前端渲染模板 =================
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

            /* 右键菜单 */
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
        </style>
        <script src="https://unpkg.com/@antv/g6@4.8.24/dist/g6.min.js"></script>
    </head>
    <body>
        <div id="mountNode">正在渲染图谱...</div>

        <!-- 右键菜单 -->
        <div id="ctxMenu">
            <div class="ctx-item" data-action="source">Source</div>
        </div>

        <script>
            const vscode = acquireVsCodeApi();
            let graph = null;
            let currentData = null;
            let ctxNode = null;          // 右键目标节点
            let expandedNodes = {};      // 记录每个节点已展开的子节点 ID 列表

            // ── 主题 ──
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

            // ── 关闭右键菜单 ──
            function hideCtxMenu() {
                document.getElementById('ctxMenu').style.display = 'none';
                ctxNode = null;
            }

            // ── 折叠子树 ──
            function collapseChildren(nodeId) {
                if (!graph) return;
                const childIds = expandedNodes[nodeId];
                if (!childIds || childIds.length === 0) return;
                childIds.forEach(cid => {
                    collapseChildren(cid); // 递归折叠子孙
                    const n = graph.findById(cid);
                    if (n) graph.removeItem(n);
                });
                // 移除从 nodeId 到子节点的边
                graph.getEdges().forEach(e => {
                    const m = e.getModel();
                    if (m.source === nodeId && childIds.includes(m.target)) graph.removeItem(e);
                });
                delete expandedNodes[nodeId];
                graph.layout();
                updateExpandedStyles();
            }

            function updateExpandedStyles() {
                if (!graph) return;
                graph.getNodes().forEach(n => {
                    const m = n.getModel();
                    if (expandedNodes[m.id] && expandedNodes[m.id].length > 0) {
                        graph.updateItem(n, { style: { ...m.style, lineWidth: 3 } });
                    }
                });
            }

            function render(data) {
                currentData = data;
                const container = document.getElementById('mountNode');

                if (!data || !data.nodes || data.nodes.length === 0) {
                    container.innerHTML = '未查询到相关节点数据，请检查所选代码是否有关联。';
                    return;
                }

                container.innerHTML = '';
                const theme = getBaseTheme();

                if (!graph) {
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

                    // 双击 → 展开/折叠
                    graph.on('node:dblclick', (evt) => {
                        const model = evt.item.getModel();
                        toggleExpand(model);
                    });

                    // 右键 → 显示菜单
                    graph.on('node:contextmenu', (evt) => {
                        evt.preventDefault();
                        evt.stopPropagation();
                        ctxNode = evt.item;
                        const menu = document.getElementById('ctxMenu');
                        menu.style.display = 'block';
                        menu.style.left = evt.clientX + 'px';
                        menu.style.top = evt.clientY + 'px';
                    });

                    // 点击空白 → 关闭菜单
                    graph.on('canvas:click', () => hideCtxMenu());
                }

                updateGraphTheme(theme);
                graph.data(data);
                graph.render();
            }

            // ── 展开/折叠切换 ──
            function toggleExpand(model) {
                console.log('[toggleExpand] model.id=', model.id, ' label=', model.label, ' expanded=', !!expandedNodes[model.id]);
                if (expandedNodes[model.id] && expandedNodes[model.id].length > 0) {
                    collapseChildren(model.id);
                } else {
                    vscode.postMessage({ command: 'expandNode', payload: { symbol: model.id } });
                }
            }

            // ── 增量添加展开节点 ──
            function addNodes(parentId, nodes, edges) {
                if (!graph) return;
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
                // 记录展开关系 + 同步到 currentData
                if (!expandedNodes[parentId]) expandedNodes[parentId] = [];
                expandedNodes[parentId].push(...addedIds);
                currentData.nodes.push(...nodes);
                currentData.edges.push(...edges);

                graph.layout();
                updateExpandedStyles();
            }

            // ── 主题更新 ──
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

            // ── 右键菜单点击 ──
            document.getElementById('ctxMenu').addEventListener('click', (e) => {
                const item = e.target.closest('[data-action]');
                const action = item ? item.getAttribute('data-action') : null;
                const node = ctxNode; // 先保存：hideCtxMenu 会清空 ctxNode
                hideCtxMenu();
                if (!action || !node) return;
                if (action === 'source') {
                    const model = node.getModel();
                    console.log('[ctxMenu] source click, model:', model.id, model.filePath, model.line);
                    vscode.postMessage({
                        command: 'openFile',
                        payload: { name: model.id, path: model.filePath, line: model.line }
                    });
                }
            });

            // ── 消息监听 ──
            window.addEventListener('message', event => {
                const msg = event.data;
                if (msg.command === 'renderGraph') {
                    render(msg.data);
                }
                if (msg.command === 'addNodes') {
                    addNodes(msg.data.parentId, msg.data.nodes, msg.data.edges);
                }
            });

            // ── 主题切换监听 ──
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