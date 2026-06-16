import * as vscode from 'vscode';
// 假设这是 CodeGraph 的标准调用方式，具体以其官方 API 文档为准
import { CodeGraph } from '@colbymchenry/codegraph';

export function activate(context: vscode.ExtensionContext) {
    let disposable = vscode.commands.registerCommand('codegraph-g6.showGraph', async () => {
        // 1. 获取当前编辑器和选中的文本（例如函数名或类名）
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('没有打开的编辑器');
            return;
        }

        const selection = editor.document.getText(editor.selection);
        if (!selection) {
            vscode.window.showWarningMessage('请先选中一个函数名或变量名');
            return;
        }

        // 2. 获取当前工作区路径，用于初始化 CodeGraph
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            vscode.window.showErrorMessage('请在一个工作区（Workspace）内使用');
            return;
        }
        const workspaceRoot = workspaceFolders[0].uri.fsPath;

        try {
            // 3. 连接本地的 CodeGraph 数据库并查询数据
            const cg = await CodeGraph.open(workspaceRoot);
            
            // 将 CodeGraph 的数据转换为 AntV G6 的 nodes 和 edges
            const graphData = await buildGraphData(cg, selection);

            // 4. 创建并打开 Webview 面板
            const panel = vscode.window.createWebviewPanel(
                'codegraphWebview',
                `Graph: ${selection}`,
                vscode.ViewColumn.Beside, // 在侧边栏打开
                { enableScripts: true, retainContextWhenHidden: true }
            );

            // 5. 设置 HTML 并发送数据
            panel.webview.html = getWebviewContent();
            
            // 确保 Webview 加载完毕后再发送数据 (这里简单通过 setTimeout 模拟，实际中最好是 Webview 发一个 ready 消息给 Extension)
            setTimeout(() => {
                panel.webview.postMessage({ command: 'renderGraph', data: graphData });
            }, 500);

        } catch (error: any) {
            vscode.window.showErrorMessage(`CodeGraph 查询失败: ${error.message}`);
        }
    });

    context.subscriptions.push(disposable);
}

// 数据转换逻辑
async function buildGraphData(cg: any, targetSymbol: string) {
    const nodes = new Map<string, any>();
    const edges: any[] = [];

    // 添加中心节点
    nodes.set(targetSymbol, { id: targetSymbol, label: targetSymbol, style: { fill: '#007ACC', stroke: '#007ACC' }, labelCfg: { style: { fill: '#fff' } } });

    // 假设 CodeGraph 提供了 getCallers 和 getCallees API
    const callers = await cg.getCallers(targetSymbol) || [];
    const callees = await cg.getCallees(targetSymbol) || [];

    // 处理调用者 (上游)
    callers.forEach((caller: any) => {
        const name = caller.name || caller;
        if (!nodes.has(name)) nodes.set(name, { id: name, label: name });
        edges.push({ source: name, target: targetSymbol });
    });

    // 处理被调用者 (下游)
    callees.forEach((callee: any) => {
        const name = callee.name || callee;
        if (!nodes.has(name)) nodes.set(name, { id: name, label: name });
        edges.push({ source: targetSymbol, target: name });
    });

    return { nodes: Array.from(nodes.values()), edges };
}

function getWebviewContent() {
    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>CodeGraph</title>
        <style>
            body { padding: 0; margin: 0; width: 100vw; height: 100vh; background-color: var(--vscode-editor-background); overflow: hidden; }
            #mountNode { width: 100%; height: 100%; }
        </style>
        <!-- 引入 AntV G6 -->
        <script src="https://unpkg.com/@antv/g6/dist/g6.min.js"></script>
    </head>
    <body>
        <div id="mountNode"></div>
        <script>
            // 获取 VS Code API
            const vscode = acquireVsCodeApi();
            let graph = null;

            function render(data) {
                if (!graph) {
                    const container = document.getElementById('mountNode');
                    const width = container.scrollWidth;
                    const height = container.scrollHeight || 600;

                    graph = new G6.Graph({
                        container: 'mountNode',
                        width,
                        height,
                        fitView: true,
                        fitViewPadding: [20, 40, 50, 20],
                        layout: {
                            type: 'dagre',    // 适合代码调用关系的树形排版
                            rankdir: 'LR',    // 从左向右排布
                            nodesep: 40,
                            ranksep: 80,
                        },
                        defaultNode: {
                            type: 'rect',
                            size: [120, 40],
                            style: { radius: 4, fill: '#2A2A2A', stroke: '#555' },
                            labelCfg: { style: { fill: '#D4D4D4', fontSize: 14 } }
                        },
                        defaultEdge: {
                            type: 'cubic-horizontal',
                            style: { stroke: '#666', endArrow: true }
                        },
                        modes: {
                            default: ['drag-canvas', 'zoom-canvas', 'drag-node']
                        }
                    });
                }
                graph.data(data);
                graph.render();
            }

            // 监听 VS Code 发来的消息
            window.addEventListener('message', event => {
                const message = event.data;
                if (message.command === 'renderGraph') {
                    render(message.data);
                }
            });
        </script>
    </body>
    </html>`;
}