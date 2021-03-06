"use strict";
import {
    workspace, window, ExtensionContext, commands,
    TextEditor, TextDocumentContentProvider, EventEmitter,
    Event, Uri, TextDocumentChangeEvent, ViewColumn,
    TextEditorSelectionChangeEvent,
    TextDocument, Disposable, OutputChannel
} from "vscode";
import { exec } from "child_process";
import * as fs from "fs";
import * as path from "path";
let fileUrl = require("file-url");

export function activate(context: ExtensionContext) {
    
    let provider = new RstDocumentContentProvider(context);
    let registration = workspace.registerTextDocumentContentProvider("restructuredtext", provider);

    let d1 = commands.registerCommand("restructuredtext.showPreview", showPreview);
    let d2 = commands.registerCommand("restructuredtext.showPreviewToSide", uri => showPreview(uri, true));
    let d3 = commands.registerCommand("restructuredtext.showSource", showSource);

    context.subscriptions.push(d1, d2, d3, registration);

    workspace.onDidSaveTextDocument(document => {
        if (isRstFile(document)) {
            const uri = getRstUri(document.uri);
            provider.update(uri);
        }
    });

    let updateOnTextChanged = RstDocumentContentProvider.loadSetting("updateOnTextChanged", "true");
    if (updateOnTextChanged === 'true') {
        workspace.onDidChangeTextDocument(event => {
            if (isRstFile(event.document)) {
                const uri = getRstUri(event.document.uri);
                provider.update(uri);
            }
        });
    }

    workspace.onDidChangeConfiguration(() => {
        workspace.textDocuments.forEach(document => {
            if (document.uri.scheme === 'restructuredtext') {
                // update all generated md documents
                provider.update(document.uri);
            }
        });
    });
}

function isRstFile(document: TextDocument) {
    return document.languageId === 'restructuredtext'
        && document.uri.scheme !== 'restructuredtext'; // prevent processing of own documents
}

function getRstUri(uri: Uri) {
    return uri.with({ scheme: 'restructuredtext', path: uri.path + '.rendered', query: uri.toString() });
}

function showPreview(uri?: Uri, sideBySide: boolean = false) {
    let resource = uri;
    if (!(resource instanceof Uri)) {
        if (window.activeTextEditor) {
            // we are relaxed and don't check for markdown files
            resource = window.activeTextEditor.document.uri;
        }
    }

    if (!(resource instanceof Uri)) {
        if (!window.activeTextEditor) {
            // this is most likely toggling the preview
            return commands.executeCommand('restructuredtext.showSource');
        }
        // nothing found that could be shown or toggled
        return;
    }

    let thenable = commands.executeCommand('vscode.previewHtml',
        getRstUri(resource),
        getViewColumn(sideBySide),
        `Preview '${path.basename(resource.fsPath)}'`);

    return thenable;
}

function getViewColumn(sideBySide): ViewColumn {
    const active = window.activeTextEditor;
    if (!active) {
        return ViewColumn.One;
    }

    if (!sideBySide) {
        return active.viewColumn;
    }

    switch (active.viewColumn) {
        case ViewColumn.One:
            return ViewColumn.Two;
        case ViewColumn.Two:
            return ViewColumn.Three;
    }

    return active.viewColumn;
}

function showSource(mdUri: Uri) {
    if (!mdUri) {
        return commands.executeCommand('workbench.action.navigateBack');
    }

    const docUri = Uri.parse(mdUri.query);

    for (let editor of window.visibleTextEditors) {
        if (editor.document.uri.toString() === docUri.toString()) {
            return window.showTextDocument(editor.document, editor.viewColumn);
        }
    }

    return workspace.openTextDocument(docUri).then(doc => {
        return window.showTextDocument(doc);
    });
}

// this method is called when your extension is deactivated
export function deactivate() {
}

class RstDocumentContentProvider implements TextDocumentContentProvider {
    private _context: ExtensionContext;
    private _onDidChange = new EventEmitter<Uri>();
    private _waiting: boolean;
    private _input: string;
    private _output: string;
    private _cmd: string;
    private _options: any;
    private _channel: OutputChannel;

    constructor(context: ExtensionContext) {
        this._context = context;
        this._waiting = false;
        this._channel = window.createOutputChannel("reStructuredText");
        context.subscriptions.push(this._channel);
    }

    public provideTextDocumentContent(uri: Uri): string | Thenable<string> {
        let root = workspace.rootPath;
        this._input = RstDocumentContentProvider.loadSetting("confPath", root);
        this._output = RstDocumentContentProvider.loadSetting("builtDocumentationPath", path.join(root, "_build", "html"));
        let quotedOutput = "\"" + this._output + "\"";

        var python = RstDocumentContentProvider.loadSetting("pythonPath", null, "python");
        var build: string;
        if (python == null) {
            build = RstDocumentContentProvider.loadSetting('sphinxBuildPath', null);
        }
        else {
            build = python + " -msphinx";
        }

        if (build == null) {
            build = "sphinx-build";
        }

        this._options = { cwd: this._input };
        this._cmd = [
            build,
            "-b html",
            ".",
            quotedOutput
        ].join(" ");
        return this.preview(uri);
    }

    get onDidChange(): Event<Uri> {
        return this._onDidChange.event;
    }

    public update(uri: Uri) {
        if (!this._waiting) {
            this._waiting = true;
            setTimeout(() => {
                this._waiting = false;
                this._onDidChange.fire(uri);
            }, 300);
        }
    }

    private errorSnippet(error: string): string {
        return `
                <body>
                    ${error}
                </body>`;
    }

    private fixLinks(document: string, documentPath: string): string {
        return document.replace(
            new RegExp("((?:src|href)=[\'\"])(.*?)([\'\"])", "gmi"), (subString: string, p1: string, p2: string, p3: string): string => {
                return [
                    p1,
                    fileUrl(path.join(
                        path.dirname(documentPath),
                        p2
                    )),
                    p3
                ].join("");
            }
        );
    }

    public static loadSetting(
        configSection: string, defaultValue: string, header: string = "restructuredtext", expand: boolean = true
    ): string {
        var result = workspace.getConfiguration(header).get(configSection, defaultValue);
        if (expand && result != null) {
            return RstDocumentContentProvider.expandMacro(result);
        }

        return result;
    }

    private static expandMacro(input: string): string {
        let root = workspace.rootPath;
        return input.replace("${workspaceRoot}", root);
    }

    private relativeDocumentationPath(whole: string): string {
        return whole.substring(this._input.length);
    }

    private preview(uri: Uri): Thenable<string> {
        // Calculate full path to built html file.
        let whole = uri.fsPath;
        if (whole.endsWith(".rendered"))
            whole = whole.substring(0, whole.lastIndexOf("."));
        let ext = whole.lastIndexOf(".");
        whole = whole.substring(0, ext) + ".html";

        let finalName = path.join(this._output, this.relativeDocumentationPath(whole));

        this._channel.appendLine("Source file: " + uri.fsPath);
        this._channel.appendLine("Compiler: " + this._cmd);
        this._channel.appendLine("HTML file: " + finalName);

        // Display file.
        return new Promise<string>((resolve, reject) => {
            exec(this._cmd, this._options, (error, stdout, stderr) => {
                if (error) {
                    let errorMessage = [
                        error.name,
                        error.message,
                        error.stack,
                        "",
                        stderr.toString()
                    ].join("\n");
                    console.error(errorMessage);
                    this._channel.appendLine("Error: " + errorMessage);
                    reject(errorMessage);
                    return;
                }

                if (process.platform === "win32" && stderr) {
                    let errorMessage = stderr.toString();
                    if (errorMessage.indexOf("Exception occurred:") > -1) {
                        console.error(errorMessage);
                        this._channel.appendLine("Error: " + errorMessage);
                        reject(errorMessage);
                        return;
                    }
                }

                fs.stat(finalName, (error, stat) => {
                    if (error !== null) {
                        let errorMessage = [
                            error.name,
                            error.message,
                            error.stack
                        ].join("\n");
                        console.error(errorMessage);
                        this._channel.appendLine("Error: " + errorMessage);
                        reject(errorMessage);
                        return;
                        //} else if(err.code === 'ENOENT') {
                        //    fs.writeFile('log.txt', 'Some log\n');
                    }

                    fs.readFile(finalName, "utf8", (err, data) => {
                        if (err === null) {
                            let fixed = this.fixLinks(data, finalName);
                            resolve(fixed);
                        } else {
                            let errorMessage = [
                                err.name,
                                err.message,
                                err.stack
                            ].join("\n");
                            console.error(errorMessage);
                            this._channel.appendLine("Error: " + errorMessage);
                            reject(errorMessage);
                        }
                    });
                });
            });
        });
    }
}
