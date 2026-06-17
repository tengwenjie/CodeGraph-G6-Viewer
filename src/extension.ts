import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { CodeGraph } from '@colbymchenry/codegraph';
import { getWebviewContent } from './webview/getWebviewContent'

export function activate(context: vscode.ExtensionContext) {
    // ── Check CodeGraph initialization on startup ──
    checkCodeGraphInitialized();

    // ── Main command: show graph ──
    const showGraphDisposable = vscode.commands.registerCommand('codegraph-g6.showGraph', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('No active editor');
            return;
        }

        const selection = editor.document.getText(editor.selection).trim();
        const currentFilePath = editor.document.uri.fsPath;
        const currentFileName = editor.document.fileName.split(/[/\\]/).pop() || 'Current File';

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            vscode.window.showErrorMessage('Please open a workspace folder');
            return;
        }
        const workspaceRoot = workspaceFolders[0].uri.fsPath;

        // Guard: refuse to run if not initialized
        if (!CodeGraph.isInitialized(workspaceRoot)) {
            const action = await vscode.window.showWarningMessage(
                'CodeGraph has not been initialized for this workspace. Run initialization now?',
                'Initialize', 'Cancel'
            );
            if (action === 'Initialize') {
                await runCodeGraphInit(workspaceRoot);
            }
            return;
        }

        try {
            const cg = await CodeGraph.open(workspaceRoot);

            let graphData;
            let panelTitle;

            const relativePath = vscode.workspace.asRelativePath(currentFilePath, false);

            if (selection) {
                graphData = await buildGraphDataForSymbol(cg, selection, relativePath);
                panelTitle = `Graph: ${selection}`;
            } else {
                graphData = await buildGraphDataForFile(cg, relativePath);
                panelTitle = `File Graph: ${currentFileName}`;
            }

            const panel = vscode.window.createWebviewPanel(
                'codegraphWebview',
                panelTitle,
                vscode.ViewColumn.Beside,
                { enableScripts: true, retainContextWhenHidden: true }
            );

            panel.webview.onDidReceiveMessage(async (message) => {
                if (message.command === 'openFile') {
                    const payload = message.payload;
                    console.log(`[openFile] jump request: path=${payload.path}  line=${payload.line}  name=${payload.name}`);

                    if (!payload.path) {
                        vscode.window.showWarningMessage('This node has no file path information');
                        return;
                    }

                    try {
                        const workspaceFolders = vscode.workspace.workspaceFolders;
                        if (!workspaceFolders) {
                            vscode.window.showErrorMessage('Please open a workspace folder first');
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
                        console.log(`[openFile] resolved Uri: ${fileUri.fsPath}`);

                        const doc = await vscode.workspace.openTextDocument(fileUri);
                        const editor = await vscode.window.showTextDocument(doc);

                        const targetLine = payload.line ? Math.max(0, payload.line - 1) : 0;
                        const range = doc.lineAt(targetLine).range;

                        editor.selection = new vscode.Selection(range.start, range.end);
                        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);

                    } catch (err) {
                        console.error('Jump failed:', err);
                        vscode.window.showErrorMessage(`Cannot open file: ${payload.path}`);
                    }
                }

                if (message.command === 'expandNode') {
                    const { symbol } = message.payload;
                    try {
                        const cg2 = await CodeGraph.open(workspaceRoot);
                        const newData = expandNodeById(cg2, symbol);
                        const filteredNodes = newData.nodes.filter((n: any) => n.id !== symbol);
                        panel.webview.postMessage({
                            command: 'addNodes',
                            data: { parentId: symbol, nodes: filteredNodes, edges: newData.edges },
                        });
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`Expand node failed: ${err.message}`);
                    }
                }
            });

            panel.webview.html = getWebviewContent();

            setTimeout(() => {
                panel.webview.postMessage({ command: 'renderGraph', data: graphData });
            }, 500);

        } catch (error: any) {
            vscode.window.showErrorMessage(`CodeGraph query failed: ${error.message}`);
        }
    });

    // ── Manual init / re-index command ──
    const manualInitDisposable = vscode.commands.registerCommand('codegraph-g6.manualInit', async () => {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            vscode.window.showErrorMessage('Please open a workspace folder first');
            return;
        }
        const workspaceRoot = workspaceFolders[0].uri.fsPath;
        await runCodeGraphInit(workspaceRoot);
    });

    context.subscriptions.push(showGraphDisposable, manualInitDisposable);
}

// ================= Check CodeGraph initialization (silent) =================
function checkCodeGraphInitialized() {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) { return; }

    const uninitialized: string[] = [];
    for (const folder of workspaceFolders) {
        if (!CodeGraph.isInitialized(folder.uri.fsPath)) {
            uninitialized.push(folder.name);
        }
    }

    if (uninitialized.length > 0) {
        // Silent hint — the real prompt happens when the user runs the command
        console.log(`CodeGraph: workspace not initialized for ${uninitialized.join(', ')}. Use "CodeGraph: Initialize / Re-index" to index.`);
    }
}

// ================= Estimate codebase size & duration =================
function estimateCodebaseSize(workspaceRoot: string): { fileCount: number; estimatedMinutes: number } {
    const EXCLUDE_DIRS = new Set(['node_modules', '.git', '.codegraph', 'dist', 'out', 'build', '.next', '__pycache__', 'vendor', 'target', 'bin', 'obj']);
    const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.cs', '.php', '.rb', '.swift', '.kt', '.dart', '.c', '.cpp', '.h', '.hpp', '.scala', '.lua', '.r', '.vue', '.svelte', '.astro']);
    let fileCount = 0;

    function walk(dir: string, depth: number) {
        if (depth > 8) return;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
        catch { return; }

        for (const entry of entries) {
            if (entry.isDirectory()) {
                if (EXCLUDE_DIRS.has(entry.name)) continue;
                walk(path.join(dir, entry.name), depth + 1);
            } else if (entry.isFile()) {
                if (SOURCE_EXTS.has(path.extname(entry.name).toLowerCase())) {
                    fileCount++;
                }
            }
        }
    }

    walk(workspaceRoot, 0);
    // Rough heuristic: ~80ms per file, clamped to 0.5–30 minutes
    const estimatedMs = Math.min(Math.max(fileCount * 80, 30000), 1800000);
    return { fileCount, estimatedMinutes: Math.round(estimatedMs / 60000) };
}

function formatElapsed(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function stripAnsi(text: string): string {
    // eslint-disable-next-line no-control-regex
    return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\[\d*[KJh]/g, '').trim();
}

function formatEstimate(minutes: number): string {
    if (minutes < 1) return '< 1 min';
    if (minutes === 1) return '~1 min';
    return `~${minutes} min`;
}

// ================= Run codegraph init via child_process =================
async function runCodeGraphInit(workspaceRoot: string): Promise<void> {
    const { fileCount, estimatedMinutes } = estimateCodebaseSize(workspaceRoot);
    const estimateStr = formatEstimate(estimatedMinutes);

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `CodeGraph: Indexing (${fileCount} source files, est. ${estimateStr})`,
        cancellable: false,
    }, async (progress) => {
        const startTime = Date.now();

        // Elapsed-time ticker — updates every second
        const timer = setInterval(() => {
            const elapsed = Math.floor((Date.now() - startTime) / 1000);
            progress.report({ message: `Elapsed ${formatElapsed(elapsed)} / est. ${estimateStr}` });
        }, 1000);

        return new Promise<void>((resolve) => {
            const child = cp.spawn('npx', ['@colbymchenry/codegraph', 'init'], {
                cwd: workspaceRoot,
                shell: true,
                stdio: ['ignore', 'pipe', 'pipe'],
            });

            let stdout = '';
            let stderr = '';

            child.stdout?.on('data', (data: Buffer) => {
                stdout += data.toString();
            });

            child.stderr?.on('data', (data: Buffer) => {
                stderr += data.toString();
            });

            child.on('close', (code: number | null) => {
                clearInterval(timer);
                const elapsed = Math.floor((Date.now() - startTime) / 1000);
                if (code === 0) {
                    vscode.window.showInformationMessage(
                        `CodeGraph initialization complete in ${formatElapsed(elapsed)}. You can now use "CodeGraph: Show Node Graph".`
                    );
                } else {
                    const errMsg = stripAnsi(stderr.trim() || stdout.trim()) || `Exit code: ${code}`;
                    vscode.window.showErrorMessage(`CodeGraph init failed after ${formatElapsed(elapsed)}: ${errMsg}`);
                }
                resolve();
            });

            child.on('error', (err: NodeJS.ErrnoException) => {
                clearInterval(timer);
                // npx not found — fall back to programmatic API
                console.warn(`Failed to spawn npx: ${err.message}. Falling back to programmatic init.`);
                CodeGraph.init(workspaceRoot, {
                    onProgress: (_p) => {
                        const elapsed = Math.floor((Date.now() - startTime) / 1000);
                        progress.report({ message: `Elapsed ${formatElapsed(elapsed)} / est. ${estimateStr}` });
                    },
                }).then(() => {
                    const elapsed = Math.floor((Date.now() - startTime) / 1000);
                    vscode.window.showInformationMessage(
                        `CodeGraph initialization complete in ${formatElapsed(elapsed)}. You can now use "CodeGraph: Show Node Graph".`
                    );
                    resolve();
                }).catch((apiErr: any) => {
                    vscode.window.showErrorMessage(`CodeGraph init failed: ${apiErr.message}`);
                    resolve();
                });
            });
        });
    });
}

// ================= Shared helper: add a CodeGraph Node to the nodesMap =================
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

// ================= Build graph data centered on a single selected symbol =================
function buildGraphDataForSymbol(cg: CodeGraph, targetSymbol: string, currentFilePath: string) {
    const nodesMap = new Map<string, any>();
    const edgesList: any[] = [];
    const edgeSet = new Set<string>();

    const searchResults = cg.searchNodes(targetSymbol);

    if (!searchResults || searchResults.length === 0) {
        return { nodes: [], edges: [] };
    }

    let centerNode = searchResults[0].node;
    for (const result of searchResults) {
        if (result.node.filePath === currentFilePath) {
            centerNode = result.node;
            break;
        }
    }
    console.log(`[buildGraphDataForSymbol] symbol=${targetSymbol}  center=${centerNode.name}  filePath=${centerNode.filePath}`);

    addNodeToMap(nodesMap, centerNode, true);

    const incomingEdges = cg.getIncomingEdges(centerNode.id) || [];
    const outgoingEdges = cg.getOutgoingEdges(centerNode.id) || [];

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

// ================= Expand one level by node ID (no search needed) =================
function expandNodeById(cg: CodeGraph, nodeId: string) {
    const nodesMap = new Map<string, any>();
    const edgesList: any[] = [];
    const edgeSet = new Set<string>();

    const centerNode = cg.getNode(nodeId);
    if (!centerNode) return { nodes: [], edges: [] };
    addNodeToMap(nodesMap, centerNode, true);

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

// ================= Build graph data for an entire file =================
function buildGraphDataForFile(cg: CodeGraph, filePath: string) {
    console.log(`[buildGraphDataForFile] input filePath = ${filePath}`);

    const nodesMap = new Map<string, any>();
    const edgesList: any[] = [];
    const edgeSet = new Set<string>();

    const fileNodes = cg.getNodesInFile(filePath);
    console.log(`[buildGraphDataForFile] getNodesInFile returned ${fileNodes.length} nodes`);

    const topLevelKinds = new Set(['function', 'method', 'class', 'interface', 'struct', 'enum', 'trait', 'protocol']);

    for (const node of fileNodes) {
        const isTopLevel = topLevelKinds.has(node.kind);
        addNodeToMap(nodesMap, node, isTopLevel);

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
