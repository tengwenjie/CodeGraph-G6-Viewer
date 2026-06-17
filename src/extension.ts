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
            const searchResults = cg.searchNodes(selection);
            console.log(`搜索 [${selection}] 的结果:`, searchResults);
            
            let graphData;
            let panelTitle;

            // 4. 核心分流逻辑：判断是查单个节点，还是查整个文件
            if (selection) {
                // 如果鼠标高亮选中了某个关键字
                graphData = await buildGraphDataForSymbol(cg, selection, currentFilePath, editor);
                panelTitle = `Graph: ${selection}`;
            } else {
                // 如果没有选中任何文字（只是单纯右键）
                graphData = await buildGraphDataForFile(cg, currentFilePath);
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
            panel.webview.onDidReceiveMessage(async (message) => {
                if (message.command === 'openFile') {
                    const { path, line } = message.payload;
                    if (!path) {
                        vscode.window.showWarningMessage('该节点没有关联的源文件路径');
                        return;
                    }

                    try {
                        const doc = await vscode.workspace.openTextDocument(path);
                        const targetEditor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);

                        // 高亮并跳转到对应行
                        if (line) {
                            const position = new vscode.Position(line - 1, 0);
                            targetEditor.selection = new vscode.Selection(position, position);
                            targetEditor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
                        }
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`无法打开文件: ${err.message}`);
                    }
                }
            }, undefined, context.subscriptions);

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

// ================= 数据组装逻辑 1：针对单个选中的关键字 =================
// 【修复】：加上了第四个参数 editor: vscode.TextEditor
function buildGraphDataForSymbol(cg: any, targetSymbol: string, currentFilePath: string, editor: vscode.TextEditor) {
    const nodesMap = new Map<string, any>();
    const edgesList: any[] = [];

    // 1. 搜索选中的关键字
    const searchResults = cg.searchNodes(targetSymbol);
    
    // 如果没搜到，直接返回空图
    if (!searchResults || searchResults.length === 0) {
        return { nodes: [], edges: [] };
    }

    const centerNode = searchResults[0].node; 
    const centerId = centerNode.id;

    // 把中心节点放进画布
    nodesMap.set(centerId, { 
        id: centerId, 
        label: centerNode.name || targetSymbol, 
        filePath: centerNode.filePath || currentFilePath, 
        line: (editor.selection.active.line || 0) + 1, // 利用 editor 获取行号
        kind: centerNode.kind,
        style: { fill: '#007ACC', stroke: '#007ACC' }, 
        labelCfg: { style: { fill: '#fff' } } 
    });

    // 3. 获取上游和下游连线
    const incomingEdges = cg.getIncomingEdges(centerId) || [];
    const outgoingEdges = cg.getOutgoingEdges(centerId) || [];

    // 【修改点 1】：处理上游连线
    for (const edge of incomingEdges) {
        const sourceId = edge.source || edge.sourceId; 
        if (!nodesMap.has(sourceId)) {
            // 尝试通过 ID 查出真实的节点数据
            // 如果 API 不叫 getNode，请换成真实的函数名
            const sourceNode = cg.getNode ? cg.getNode(sourceId) : null; 
            
            nodesMap.set(sourceId, { 
                id: sourceId, 
                // 优先使用查出来的 name，查不到再回退到 ID
                label: sourceNode ? sourceNode.name : sourceId.split('/').pop(), 
                filePath: sourceNode ? sourceNode.filePath : null,
                kind: sourceNode ? sourceNode.kind : null
            });
        }
        edgesList.push({ source: sourceId, target: centerId });
    }

    // 【修改点 2】：处理下游连线
    for (const edge of outgoingEdges) {
        const targetId = edge.target || edge.targetId;
        if (!nodesMap.has(targetId)) {
            // 尝试通过 ID 查出真实的节点数据
            const targetNode = cg.getNode ? cg.getNode(targetId) : null;

            nodesMap.set(targetId, { 
                id: targetId, 
                label: targetNode ? targetNode.name : targetId.split('/').pop(), 
                filePath: targetNode ? targetNode.filePath : null,
                kind: targetNode ? targetNode.kind : null
            });
        }
        edgesList.push({ source: centerId, target: targetId });
    }

    return { nodes: Array.from(nodesMap.values()), edges: edgesList };
}

// ================= 数据组装逻辑 2：针对整个文件 =================
function buildGraphDataForFile(cg: any, filePath: string) {
    // 逻辑非常相似：先用 searchNodes 搜当前文件路径
    // 如果你们的代码支持查整个文件的全量节点，也可以用类似逻辑替换
    const searchResults = cg.searchNodes(filePath);
    
    const nodesMap = new Map<string, any>();
    const edgesList: any[] = [];

    // 把当前文件相关的搜索结果都当成节点
    searchResults.forEach((result: any) => {
        const node = result.node;
        nodesMap.set(node.id, {
            id: node.id,
            label: node.name,
            filePath: node.filePath
        });

        // 获取每个节点的输出连线（这里简化演示，只取输出线避免线太多）
        const edges = cg.getOutgoingEdges(node.id) || [];
        edges.forEach((edge: any) => {
            edgesList.push({
                source: edge.source || edge.sourceId,
                target: edge.target || edge.targetId
            });
        });
    });

    return { nodes: Array.from(nodesMap.values()), edges: edgesList };
}
