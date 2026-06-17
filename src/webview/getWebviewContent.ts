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
        </style>
        <script src="https://unpkg.com/@antv/g6@4.8.24/dist/g6.min.js"></script>
    </head>
    <body>
        <div id="mountNode">正在渲染图谱...</div>
        <script>
            const vscode = acquireVsCodeApi();
            let graph = null;
            let currentData = null;

            // 1. 获取全局基础主题
            function getBaseTheme() {
                const isLight = document.body.classList.contains('vscode-light');
                return {
                    isLight,
                    edgeStroke: isLight ? '#A3A3A3' : '#666666',
                    centerNodeFill: isLight ? '#007ACC' : '#005A9E', 
                    centerNodeLabel: '#FFFFFF',
                    // 默认节点颜色（兜底用）
                    defaultFill: isLight ? '#F3F3F3' : '#2D2D30',
                    defaultStroke: isLight ? '#CECECE' : '#555555',
                    defaultLabel: isLight ? '#333333' : '#D4D4D4'
                };
            }

            // 2. 根据 node.kind 获取专属样式
            function getStyleByKind(kind, theme) {
                const kindPalette = {
                    'class': { fill: theme.isLight ? '#E8DFF5' : '#4B326B', stroke: theme.isLight ? '#C3A5E4' : '#6A4A93' },
                    'interface': { fill: theme.isLight ? '#D1E7DD' : '#1E3A2F', stroke: theme.isLight ? '#A3D0B6' : '#2E5A48' },
                    
                    // method 保持黄色系
                    'method': { fill: theme.isLight ? '#FFF3CD' : '#4D4119', stroke: theme.isLight ? '#FFE69C' : '#756429' },
                    
                    // 👇 【修改】：给 function 换上一套全新的粉色/玫瑰色系
                    'function': { fill: theme.isLight ? '#FCE4EC' : '#6A1B38', stroke: theme.isLight ? '#F48FB1' : '#AD1457' },
                    
                    'file': { fill: theme.isLight ? '#FAD7A1' : '#784212', stroke: theme.isLight ? '#F5B041' : '#E67E22' }
                };

                const safeKind = kind ? kind.toLowerCase() : 'unknown';
                const colorConfig = kindPalette[safeKind];

                return {
                    fill: colorConfig ? colorConfig.fill : theme.defaultFill,
                    stroke: colorConfig ? colorConfig.stroke : theme.defaultStroke,
                    labelFill: theme.defaultLabel
                };
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
                        width,
                        height,
                        fitView: true,
                        fitViewPadding: [20, 40, 50, 20],
                        layout: {
                            type: 'dagre',
                            rankdir: 'LR',
                            nodesep: 40,
                            ranksep: 80,
                        },
                        defaultNode: {
                            type: 'rect',
                            size: [140, 40],
                            style: { radius: 6, cursor: 'pointer', lineWidth: 1.5 }, // 稍微加粗了边框，增加了圆角
                            labelCfg: { style: { fontSize: 13 } }
                        },
                        defaultEdge: {
                            type: 'cubic-horizontal',
                            style: { endArrow: true }
                        },
                        modes: {
                            default: ['drag-canvas', 'zoom-canvas', 'drag-node']
                        }
                    });

                    graph.on('node:click', (evt) => {
                        const { item } = evt;
                        const model = item.getModel();
                        vscode.postMessage({
                            command: 'openFile',
                            payload: { name: model.id, path: model.filePath, line: model.line }
                        });
                    });
                }
                
                updateGraphTheme(theme);
                graph.data(data);
                graph.render();
            }

            // 3. 动态遍历并更新节点颜色
            function updateGraphTheme(theme) {
                if (!currentData) return;
                
                currentData.nodes.forEach(node => {
                    console.log("节点查岗 -> 名字: ", node.label, ", 类型: ", node.kind);
                    // 判断是否是中心起点
                    const isCenterNode = node.style && (node.style.fill === '#007ACC' || node.style.fill === '#005A9E');
                    
                    
                    // 根据 kind 计算该节点的颜色
                    const kindStyle = getStyleByKind(node.kind, theme);

                    node.style = {
                        ...node.style,
                        // 如果是中心节点，强行覆盖为中心蓝色；否则使用 kind 算出来的颜色
                        fill: isCenterNode ? theme.centerNodeFill : kindStyle.fill,
                        stroke: isCenterNode ? theme.centerNodeFill : kindStyle.stroke
                    };
                    
                    node.labelCfg = {
                        style: { fill: isCenterNode ? theme.centerNodeLabel : kindStyle.labelFill }
                    };
                });

                currentData.edges.forEach(edge => {
                    edge.style = { ...edge.style, stroke: theme.edgeStroke };
                });
            }

            window.addEventListener('message', event => {
                const message = event.data;
                if (message.command === 'renderGraph') {
                    render(message.data);
                }
            });

            // 监听 VS Code 主题实时切换
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