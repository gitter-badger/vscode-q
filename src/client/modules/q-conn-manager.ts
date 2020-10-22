/**
 * Copyright (c) 2020 Jo Shinonome
 *
 * This software is released under the MIT License.
 * https://opensource.org/licenses/MIT
 */

import * as fs from 'fs';
import * as q from 'node-q';
import { homedir } from 'os';
import { commands, window, workspace, Uri } from 'vscode';
import { QConn } from './q-conn';
import { QStatusBarManager } from './q-status-bar-manager';
import { QueryConsole } from './query-console';
import { QueryView } from './query-view';
import path = require('path');

const cfgDir = homedir() + '/.vscode/';
const cfgPath = cfgDir + 'q-server-cfg.json';

export class QConnManager {
    public static current: QConnManager | undefined;
    qConnPool = new Map<string, QConn>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    qCfg: QCfg[] = [];
    activeConn: QConn | undefined;
    isBusy = false;
    busyConn: QConn | undefined = undefined;
    queryWrapper = '';
    isLimited = true;
    // exception: true|false
    // type: number
    // data: return
    // cols: columns of table
    public static queryWrapper = '';
    public static consoleMode = false;

    public static create(): QConnManager {
        if (!this.current) {
            this.current = new QConnManager();
        }
        return this.current;
    }

    private constructor() {
        this.loadCfg();
        this.updateQueryWrapper();
    }

    public static toggleMode(): void {
        QConnManager.consoleMode = !QConnManager.consoleMode;
        QConnManager.current?.updateQueryWrapper();
    }

    // when switch a server or toggle query mode, update wrapper
    public updateQueryWrapper(): void {
        const limit = this.isLimited ? '1000 sublist ' : '';
        const consoleSize = '36 180|system"c"';
        const wrapper = QConnManager.consoleMode
            ? `{\`t\`r!(0b;.Q.S[${consoleSize};0j;value x])}`
            : `{res:value x;$[(count res) & .Q.qt res;:\`t\`r\`m!(1b;${limit}0!res;0!meta res);:\`t\`r!(0b;.Q.S[${consoleSize};0j;res])]}`;
        if (this.activeConn && this.activeConn.version < 3.5)
            this.queryWrapper = wrapper;
        else
            this.queryWrapper = `{{-105!(x;enlist y;{\`t\`r!(0b;x,"\n",.Q.sbt@(-3)_y)})}[${wrapper};x]}`;
    }


    public toggleLimitQuery(): void {
        this.isLimited = !this.isLimited;
        QStatusBarManager.updateUnlimitedQueryStatus(this.isLimited);
        this.updateQueryWrapper();
    }

    getConn(uniqLabel: string): QConn | undefined {
        return this.qConnPool.get(uniqLabel);
    }

    connect(uniqLabel: string): void {
        try {
            const qConn = this.getConn(uniqLabel);
            if (qConn) {
                const conn = qConn.conn;
                if (conn) {
                    this.activeConn = qConn;
                    QStatusBarManager.updateConnStatus(uniqLabel);
                    commands.executeCommand('q-servers.refreshEntry');
                    commands.executeCommand('q-explorer.refreshEntry');
                    this.updateQueryWrapper();
                } else {
                    q.connect(qConn,
                        (err, conn) => {
                            if (err) window.showErrorMessage(err.message);
                            if (conn) {
                                conn.addListener('close', _hadError => {
                                    if (_hadError) {
                                        console.log('Error happened during closing connection');
                                    }
                                    this.removeConn(uniqLabel);
                                });
                                qConn?.setConn(conn);
                                this.activeConn = qConn;
                                commands.executeCommand('q-servers.refreshEntry');
                                commands.executeCommand('q-explorer.refreshEntry');
                                QStatusBarManager.updateConnStatus(uniqLabel);
                            }
                        }
                    );
                }
            }
        } catch (error) {
            window.showErrorMessage(`Failed to connect to '${uniqLabel}', please check q-server-cfg.json`);
        }
    }

    sync(query: string): void {
        if (this.isBusy) {
            window.showWarningMessage('Still executing last query');
        } else if (this.activeConn) {
            if (query.slice(-1) === ';') {
                query = query.slice(0, -1);
            }
            this.isBusy = true;
            this.busyConn = this.activeConn;
            QStatusBarManager.updateQueryStatus(this.isBusy);
            const uniqLabel = this.activeConn?.uniqLabel.replace(',', '-');
            const time = Date.now();
            this.activeConn?.conn?.k(this.queryWrapper, query,
                (err, res) => {
                    QueryConsole.createOrShow();
                    if (err) {
                        QueryConsole.current?.append(err.message, Date.now() - time, uniqLabel);
                    }
                    if (res) {
                        if (QConnManager.consoleMode) {
                            QueryConsole.current?.append(res.r, Date.now() - time, uniqLabel);
                        } else {
                            if (res.t) {
                                QueryView.createOrShow();
                                QueryView.currentPanel?.update({
                                    type: 'json',
                                    data: res.r,
                                    meta: res.m
                                });
                                QueryConsole.current?.append(`${res.r[Object.keys(res.r)[0]].length} row(s) returned`, Date.now() - time, uniqLabel);
                            }
                            else {
                                QueryConsole.current?.append(res.r, Date.now() - time, uniqLabel);
                            }
                        }
                    }
                    this.isBusy = false;
                    this.busyConn = undefined;
                    QStatusBarManager.updateQueryStatus(this.isBusy);
                }
            );
        } else {
            window.showErrorMessage('No Active q Connection');
        }
    }

    loadCfg(): void {
        // read the q server configuration file from home dir
        if (fs.existsSync(cfgPath)) {
            this.qCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
            this.qCfg = this.qCfg.map(qcfg => {
                qcfg.uniqLabel = `${qcfg.tags},${qcfg.label}`;
                return qcfg;
            });
            // reserver current conn
            const currentQconnPool = new Map(this.qConnPool);
            this.qConnPool.clear();
            this.qCfg.forEach((qcfg: QCfg) => {
                if (!this.qConnPool.get(qcfg.uniqLabel)) {
                    this.qConnPool.set(qcfg.uniqLabel, new QConn(qcfg, currentQconnPool.get(qcfg.uniqLabel)?.conn));
                }
            });
        } else {
            if (!fs.existsSync(cfgDir)) {
                fs.mkdirSync(cfgDir);
            }
            fs.writeFileSync(cfgPath, '[]', 'utf8');
        }
    }

    async importCfg(): Promise<void> {
        if (!workspace.workspaceFolders) {
            window.showErrorMessage('No opened workspace folder');
            return;
        }
        const workspaceFolder = workspace.workspaceFolders[0].uri;
        const paths = await window.showOpenDialog({
            defaultUri: workspaceFolder,
            canSelectMany: false
        });
        let path = '';
        if (paths && paths.length > 0) {
            path = paths[0].fsPath;
        }
        if (fs.existsSync(path)) {
            try {
                const qCfg = JSON.parse(fs.readFileSync(path, 'utf8'));
                this.qCfg = qCfg.map((qcfg: QCfg) => {
                    if (qcfg.port && qcfg.label) {
                        if (!parseInt(qcfg.port as unknown as string)) {
                            window.showErrorMessage(`Please input an integer for port of '${qcfg.label}'`);
                        }
                        return {
                            host: qcfg.host,
                            port: qcfg.port,
                            user: qcfg.user ?? '',
                            password: qcfg.password ?? '',
                            socketNoDelay: qcfg.socketNoDelay ?? false,
                            socketTimeout: qcfg.socketTimeout ?? 0,
                            label: qcfg.label as string,
                            tags: qcfg.tags ?? '',
                            uniqLabel: `${qcfg.tags},${qcfg.label}`
                        };
                    } else {
                        throw new Error('Please make sure to include port and label');
                    }
                });
                this.dumpCfg();
                commands.executeCommand('q-servers.refreshEntry');
            } catch (error) {
                window.showErrorMessage(error.message);
            }
        }
    }

    async exportCfg(): Promise<void> {
        if (fs.existsSync(cfgPath)) {
            const cfg = fs.readFileSync(cfgPath, 'utf8');
            if (!workspace.workspaceFolders) {
                window.showErrorMessage('No opened workspace folder');
                return;
            }
            const workspaceFolder = workspace.workspaceFolders[0].uri.fsPath;
            const filePath = path.join(workspaceFolder, 'q-server-cfg.json');
            const fileUri = await window.showSaveDialog({
                defaultUri: Uri.parse(filePath).with({ scheme: 'file' })
            });
            if (fileUri) {
                fs.writeFile(fileUri.fsPath, cfg, err => window.showErrorMessage(err?.message ?? ''));
            }
        }
    }

    abortQuery(): void {
        this.busyConn?.conn?.close();
        this.isBusy = false;
        this.busyConn = undefined;
        QStatusBarManager.updateQueryStatus(this.isBusy);
    }

    addCfg(qcfg: QCfg): void {
        const uniqLabel = qcfg.uniqLabel;
        this.qCfg = this.qCfg.filter(qcfg => qcfg.uniqLabel !== uniqLabel);
        this.qCfg.push(qcfg);
        this.qCfg.sort((q1, q2) => q1.uniqLabel.localeCompare(q2.uniqLabel));
        this.dumpCfg();
        commands.executeCommand('q-servers.refreshEntry');
    }

    removeCfg(uniqLabel: string): void {
        this.qCfg = this.qCfg.filter(qcfg => qcfg.uniqLabel !== uniqLabel);
        this.dumpCfg();
        commands.executeCommand('q-servers.refreshEntry');
    }

    dumpCfg(): void {
        fs.writeFileSync(cfgPath, JSON.stringify(this.qCfg.map(qcfg => {
            return {
                host: qcfg.host,
                port: qcfg.port,
                user: qcfg.user,
                password: qcfg.password,
                socketNoDelay: qcfg.socketNoDelay,
                socketTimeout: qcfg.socketTimeout,
                label: qcfg.label,
                tags: qcfg.tags,
                uniqLabel: `${qcfg.tags},${qcfg.label}`
            };
        }), null, 4), 'utf8');
    }

    removeConn(uniqLabel: string): void {
        const qConn = this.getConn(uniqLabel);
        qConn?.setConn(undefined);
        if (this.activeConn?.uniqLabel === uniqLabel) {
            this.activeConn = undefined;
            QStatusBarManager.updateConnStatus(undefined);
        }
        commands.executeCommand('q-servers.refreshEntry');
        window.showWarningMessage(`Lost connection to ${uniqLabel} `);
    }
}

export type QCfg = {
    host: string;
    port: number;
    user: string;
    password: string;
    socketNoDelay: boolean;
    socketTimeout: number;
    label: string;
    tags: string;
    uniqLabel: string;
}
