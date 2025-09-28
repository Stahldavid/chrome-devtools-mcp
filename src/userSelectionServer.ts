/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createServer} from 'node:http';
import {URL} from 'node:url';

import type {McpContext} from './McpContext.js';
import {logger} from './logger.js';
import type {UserSelection, UserEdit} from './tools/ToolDefinition.js';

interface SelectionPayload {
  timestamp?: number;
  pageUrl?: string;
  selection?: {
    tagName?: string | null;
    cssPath?: string | null;
    textContent?: string | null;
    innerText?: string | null;
    outerHTML?: string | null;
    attributes?: Record<string, string>;
    dataset?: Record<string, string>;
    boundingClientRect?: {
      x: number;
      y: number;
      width: number;
      height: number;
      top?: number;
      right?: number;
      bottom?: number;
      left?: number;
    } | null;
  };
}

interface UserEditPayload {
  pageUrl?: string;
  edits: Array<{
    cssPath: string;
    tagName?: string | null;
    styles: Record<string, string>;
    summary?: string;
    timestamp?: number;
  }>;
}

function buildUserSelection(
  payload: SelectionPayload,
  pageUrlFallback: string,
): UserSelection {
  const selection = payload.selection ?? {};
  return {
    capturedAt: payload.timestamp ?? Date.now(),
    pageUrl: payload.pageUrl ?? pageUrlFallback,
    source: 'extension',
    tagName: selection.tagName ?? null,
    cssPath: selection.cssPath ?? null,
    textContent: selection.textContent ?? selection.innerText ?? null,
    innerText: selection.innerText ?? null,
    outerHTML: selection.outerHTML ?? null,
    attributes: selection.attributes,
    dataset: selection.dataset,
    boundingClientRect: selection.boundingClientRect ?? null,
  };
}

function buildUserEdits(
  payload: UserEditPayload,
  pageUrlFallback: string,
): UserEdit[] {
  const pageUrl = payload.pageUrl ?? pageUrlFallback;
  const edits = Array.isArray(payload.edits) ? payload.edits : [];
  return edits
    .filter(edit => typeof edit.cssPath === 'string' && edit.cssPath.length > 0)
    .map(edit => ({
      capturedAt: edit.timestamp ?? Date.now(),
      pageUrl,
      cssPath: edit.cssPath,
      tagName: edit.tagName ?? null,
      styles: edit.styles ?? {},
      summary: edit.summary ?? undefined,
    }));
}

export function startUserSelectionServer(
  getContext: () => Promise<McpContext>,
): void {
  const requestedPort = process.env.MCP_USER_SELECTION_PORT;
  const fallbackAllowed = !requestedPort;
  const defaultPort = Number.parseInt(requestedPort ?? '43017', 10);

  const server = createServer((req, res) => {
    if (!req.url) {
      res.writeHead(400, {'Access-Control-Allow-Origin': '*'}).end();
      return;
    }

    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'OPTIONS' && (url.pathname === '/user-selection' || url.pathname === '/user-edit')) {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'content-type',
      }).end();
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(404, {'Access-Control-Allow-Origin': '*'}).end();
      return;
    }

    if (url.pathname !== '/user-selection' && url.pathname !== '/user-edit') {
      res.writeHead(404, {'Access-Control-Allow-Origin': '*'}).end();
      return;
    }

    const chunks: Buffer[] = [];
    let totalSize = 0;
    req.on('data', chunk => {
      chunks.push(chunk);
      totalSize += chunk.length;
      if (totalSize > 512 * 1024) {
        res.writeHead(413, {'Access-Control-Allow-Origin': '*'}).end();
        req.destroy();
      }
    });

    req.on('end', async () => {
      try {
        const rawBody = Buffer.concat(chunks, totalSize).toString('utf-8');
        const context = await getContext();
        const page = context.getSelectedPage();

        if (url.pathname === '/user-selection') {
          const payload = JSON.parse(rawBody) as SelectionPayload;
          if (!payload.selection) {
            throw new Error('Missing selection payload');
          }
          const selection = buildUserSelection(payload, page.url());
          context.storeUserSelection(selection);
          logger(
            `Received user selection via extension for ${selection.pageUrl} (tag: ${selection.tagName ?? 'unknown'})`,
          );
        } else {
          const payload = JSON.parse(rawBody) as UserEditPayload;
          const edits = buildUserEdits(payload, page.url());
          if (!edits.length) {
            throw new Error('No valid edits in payload');
          }
          for (const edit of edits) {
            context.recordUserEdit(edit);
          }
          logger(`Recorded ${edits.length} user edit(s) for ${edits[0].pageUrl}`);
        }

        res.writeHead(204, {'Access-Control-Allow-Origin': '*'}).end();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger(`Failed to capture user data: ${message}`);
        res.writeHead(400, {
          'Access-Control-Allow-Origin': '*',
          'Content-Type': 'text/plain',
        }).end(message);
      }
    });
  });

  let hasFallenBack = false;
  const startListening = (port: number) => {
    server.listen(port, '127.0.0.1');
  };

  server.on('error', error => {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'EADDRINUSE' && fallbackAllowed && !hasFallenBack) {
      hasFallenBack = true;
      logger(
        `User selection port ${defaultPort} is in use, retrying with a random port.`,
      );
      startListening(0);
      return;
    }
    logger(
      `User selection server failed to listen: ${error instanceof Error ? error.message : String(error)}`,
    );
    if (!fallbackAllowed) {
      logger(
        'Set MCP_USER_SELECTION_PORT to a free port or stop the other process using it.',
      );
    }
  });

  server.on('listening', () => {
    const address = server.address();
    if (!address || typeof address === 'string') {
      return;
    }
    logger(
      `User selection HTTP endpoint listening on http://${address.address}:${address.port}/user-selection`,
    );
  });

  startListening(defaultPort);
}
