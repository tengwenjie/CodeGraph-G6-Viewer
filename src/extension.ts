import * as vscode from 'vscode';
// 假设这是 CodeGraph 的标准调用方式，具体以其官方 API 文档为准
import { CodeGraph } from '@colbymchenry/codegraph';
import { getWebviewContent } from './webview/getWebviewContent'

export function activate(context: vscode.ExtensionContext) {
    let disposable = vscode.commands.registerCommand('codegraph-g6.showGraph', async () => {
        // 1. 获取当前编辑器
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('没有打开的编辑器');
            return;
        }

        // 2. 获取选中的文本 和 当前文件路径
        const selection = editor.document.getText(editor.selection).trim();
        const currentFilePath = editor.document.uri.fsPath;
        const currentFileName = editor.document.fileName.split(/[/\\]/).pop() || 'Current File';

        // 3. 获取当前工作区路径，用于初始化 CodeGraph
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            vscode.window.showErrorMessage('请在一个工作区（Workspace）内使用');
            return;
        }
        const workspaceRoot = workspaceFolders[0].uri.fsPath;

        try {
            // 连接本地的 CodeGraph 数据库
            const cg = await CodeGraph.open(workspaceRoot);

            let graphData;
            let panelTitle;

            // CodeGraph 内部使用相对路径（相对于工作区根目录）
            const relativePath = vscode.workspace.asRelativePath(currentFilePath, false);

            // 4. 核心分流逻辑：判断是查单个节点，还是查整个文件
            if (selection) {
                // 如果鼠标高亮选中了某个关键字
                graphData = await buildGraphDataForSymbol(cg, selection, relativePath);
                panelTitle = `Graph: ${selection}`;
            } else {
                // 如果没有选中任何文字（只是单纯右键）
                graphData = await buildGraphDataForFile(cg, relativePath);
                panelTitle = `File Graph: ${currentFileName}`;
            }

            // 5. 创建并打开 Webview 面板
            const panel = vscode.window.createWebviewPanel(
                'codegraphWebview',
                panelTitle,
                vscode.ViewColumn.Beside, // 在侧边栏打开
                { enableScripts: true, retainContextWhenHidden: true }
            );

            // 6. 监听从 Webview（前端）发回来的点击消息
            // 监听前端发回来的消息
            panel.webview.onDidReceiveMessage(async (message) => {
                if (message.command === 'openFile') {
                    const payload = message.payload;
                    console.log(`[openFile] 收到跳转请求: path=${payload.path}  line=${payload.line}  name=${payload.name}`);

                    if (!payload.path) {
                        vscode.window.showWarningMessage('该节点没有文件路径信息！');
                        return;
                    }

                    try {
                        const workspaceFolders = vscode.workspace.workspaceFolders;
                        if (!workspaceFolders) {
                            vscode.window.showErrorMessage('请先打开一个工作区/文件夹！');
                            return;
                        }
                        const rootUri = workspaceFolders[0].uri;

                        let fileUri: vscode.Uri;
                        const isAbsolute = payload.path.startsWith('/') || /^[a-zA-Z]:[\\\/]/.test(payload.path);

                        if (isAbsolute) {
                            fileUri = vscode.Uri.file(payload.path);
                        } else {
                            fileUri = vscode.Uri.joinPath(rootUri, payload.path);
                        }
                        console.log(`[openFile] 解析后 Uri: ${fileUri.fsPath}`);

                        const doc = await vscode.workspace.openTextDocument(fileUri);
                        const editor = await vscode.window.showTextDocument(doc);

                        const targetLine = payload.line ? Math.max(0, payload.line - 1) : 0;
                        const range = doc.lineAt(targetLine).range;

                        editor.selection = new vscode.Selection(range.start, range.end);
                        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);

                    } catch (err) {
                        console.error('跳转失败:', err);
                        vscode.window.showErrorMessage(`无法打开文件: ${payload.path}`);
                    }
                }

                if (message.command === 'expandNode') {
                    const { symbol } = message.payload; // symbol = node ID
                    try {
                        const cg2 = await CodeGraph.open(workspaceRoot);
                        const newData = expandNodeById(cg2, symbol);
                        // 去掉 symbol 自身，只返回新节点和边
                        const filteredNodes = newData.nodes.filter((n: any) => n.id !== symbol);
                        panel.webview.postMessage({
                            command: 'addNodes',
                            data: { parentId: symbol, nodes: filteredNodes, edges: newData.edges },
                        });
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`展开节点失败: ${err.message}`);
                    }
                }
            });

            // 7. 设置 HTML 模板
            panel.webview.html = getWebviewContent();
            
            // 确保 Webview 加载完毕后再发送数据
            setTimeout(() => {
                panel.webview.postMessage({ command: 'renderGraph', data: graphData });
            }, 500);

        } catch (error: any) {
            vscode.window.showErrorMessage(`CodeGraph 查询失败: ${error.message}`);
        }
    });

    context.subscriptions.push(disposable);
}

// ================= 共享辅助函数：将 CodeGraph Node 写入 nodesMap =================
function addNodeToMap(map: Map<string, any>, node: any, isRoot: boolean) {
    if (map.has(node.id)) { return; }
    console.log(`[addNodeToMap] id=${node.id}  name=${node.name}  filePath=${node.filePath}  line=${node.startLine}  kind=${node.kind}`);
    map.set(node.id, {
        id: node.id,
        label: node.name,
        filePath: node.filePath,
        line: node.startLine,
        kind: node.kind,
        style: isRoot ? { fill: '#007ACC', stroke: '#007ACC' } : undefined,
        labelCfg: isRoot ? { style: { fill: '#fff' } } : undefined,
    });
}

// ================= 数据组装逻辑 1：针对单个选中的关键字 =================
function buildGraphDataForSymbol(cg: CodeGraph, targetSymbol: string, currentFilePath: string) {
    const nodesMap = new Map<string, any>();
    const edgesList: any[] = [];
    const edgeSet = new Set<string>();

    // 1. 搜索选中的关键字
    const searchResults = cg.searchNodes(targetSymbol);

    if (!searchResults || searchResults.length === 0) {
        return { nodes: [], edges: [] };
    }

    // 2. 优先选择当前文件内的匹配结果，避免跳到其他文件的同名符号
    let centerNode = searchResults[0].node;
    for (const result of searchResults) {
        if (result.node.filePath === currentFilePath) {
            centerNode = result.node;
            break;
        }
    }
    console.log(`[buildGraphDataForSymbol] 选中符号=${targetSymbol}  中心节点=${centerNode.name}  filePath=${centerNode.filePath}`);

    const centerId = centerNode.id;

    // 把中心节点放进画布
    addNodeToMap(nodesMap, centerNode, true);

    // 2. 获取上游和下游连线，补全对端节点
    const incomingEdges = cg.getIncomingEdges(centerId) || [];
    const outgoingEdges = cg.getOutgoingEdges(centerId) || [];

    for (const edge of incomingEdges) {
        const key = `${edge.source}->${edge.target}`;
        if (edgeSet.has(key)) { continue; }
        edgeSet.add(key);
        edgesList.push({ source: edge.source, target: edge.target });

        const sourceNode = cg.getNode(edge.source);
        if (sourceNode) { addNodeToMap(nodesMap, sourceNode, false); }
    }

    for (const edge of outgoingEdges) {
        const key = `${edge.source}->${edge.target}`;
        if (edgeSet.has(key)) { continue; }
        edgeSet.add(key);
        edgesList.push({ source: edge.source, target: edge.target });

        const targetNode = cg.getNode(edge.target);
        if (targetNode) { addNodeToMap(nodesMap, targetNode, false); }
    }

    return { nodes: Array.from(nodesMap.values()), edges: edgesList };
}

// ================= 按节点 ID 展开一层（不需要搜索，直接用 ID 查边） =================
function expandNodeById(cg: CodeGraph, nodeId: string) {
    const nodesMap = new Map<string, any>();
    const edgesList: any[] = [];
    const edgeSet = new Set<string>();

    // 把中心节点放入
    const centerNode = cg.getNode(nodeId);
    if (!centerNode) return { nodes: [], edges: [] };
    addNodeToMap(nodesMap, centerNode, true);

    // 查出入边
    const incoming = cg.getIncomingEdges(nodeId) || [];
    const outgoing = cg.getOutgoingEdges(nodeId) || [];

    for (const edge of incoming) {
        const key = `${edge.source}->${edge.target}`;
        if (edgeSet.has(key)) continue;
        edgeSet.add(key);
        edgesList.push({ source: edge.source, target: edge.target });
        const n = cg.getNode(edge.source);
        if (n) addNodeToMap(nodesMap, n, false);
    }

    for (const edge of outgoing) {
        const key = `${edge.source}->${edge.target}`;
        if (edgeSet.has(key)) continue;
        edgeSet.add(key);
        edgesList.push({ source: edge.source, target: edge.target });
        const n = cg.getNode(edge.target);
        if (n) addNodeToMap(nodesMap, n, false);
    }

    return { nodes: Array.from(nodesMap.values()), edges: edgesList };
}

// ================= 数据组装逻辑 2：针对整个文件 =================
function buildGraphDataForFile(cg: CodeGraph, filePath: string) {
    console.log(`[buildGraphDataForFile] 输入 filePath = ${filePath}`);

    const nodesMap = new Map<string, any>();
    const edgesList: any[] = [];
    const edgeSet = new Set<string>();

    // 1. 用专用 API 获取当前文件内所有节点
    const fileNodes = cg.getNodesInFile(filePath);
    console.log(`[buildGraphDataForFile] getNodesInFile 返回 ${fileNodes.length} 个节点`);

    // 2. 筛选出有实际意义的顶层符号（过滤局部变量、参数等）
    const topLevelKinds = new Set(['function', 'method', 'class', 'interface', 'struct', 'enum', 'trait', 'protocol']);

    for (const node of fileNodes) {
        const isTopLevel = topLevelKinds.has(node.kind);
        addNodeToMap(nodesMap, node, isTopLevel);

        // 3. 只对顶层符号查询出入边，避免边爆炸
        if (!isTopLevel) { continue; }

        const outgoingEdges = cg.getOutgoingEdges(node.id) || [];
        for (const edge of outgoingEdges) {
            const key = `${edge.source}->${edge.target}`;
            if (edgeSet.has(key)) { continue; }
            edgeSet.add(key);
            edgesList.push({ source: edge.source, target: edge.target });

            const targetNode = cg.getNode(edge.target);
            if (targetNode) { addNodeToMap(nodesMap, targetNode, false); }
        }

        const incomingEdges = cg.getIncomingEdges(node.id) || [];
        for (const edge of incomingEdges) {
            const key = `${edge.source}->${edge.target}`;
            if (edgeSet.has(key)) { continue; }
            edgeSet.add(key);
            edgesList.push({ source: edge.source, target: edge.target });

            const sourceNode = cg.getNode(edge.source);
            if (sourceNode) { addNodeToMap(nodesMap, sourceNode, false); }
        }
    }

    return { nodes: Array.from(nodesMap.values()), edges: edgesList };
}
