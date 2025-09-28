/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import z from 'zod';

import {ToolCategories} from './categories.js';
import {defineTool} from './ToolDefinition.js';

export const readUserSelection = defineTool({
  name: 'read_user_selection',
  description:
    'Returns the most recent element the human shared from DevTools via the MCP Selection browser extension.',
  annotations: {
    title: 'User Selection',
    category: ToolCategories.OVERLAY,
    readOnlyHint: true,
  },
  schema: {
    includeHtml: z.boolean().default(true).describe('Include truncated outerHTML preview'),
  },
  handler: async (request, response, context) => {
    const selection = context.getLastUserSelection();
    if (!selection) {
      response.appendResponseLine(
        'No user selection has been shared yet. Ask the human to click "Send current selection" in the MCP Selection DevTools panel.',
      );
      return;
    }

    const lines: string[] = [];
    lines.push(`Captured: ${new Date(selection.capturedAt).toISOString()}`);
    lines.push(`Page URL: ${selection.pageUrl}`);
    lines.push(`Tag: ${selection.tagName ?? 'unknown'}`);
    if (selection.cssPath) {
      lines.push(`CSS path: ${selection.cssPath}`);
    }
    if (selection.boundingClientRect) {
      const rect = selection.boundingClientRect;
      lines.push(
        `Bounding box: x=${rect.x.toFixed(2)}, y=${rect.y.toFixed(2)}, width=${rect.width.toFixed(2)}, height=${rect.height.toFixed(2)}`,
      );
    }
    if (selection.textContent) {
      lines.push('Text content:');
      lines.push(selection.textContent.trim() || '(blank)');
    }
    if (request.params.includeHtml && selection.outerHTML) {
      lines.push('Outer HTML preview:');
      lines.push(selection.outerHTML);
    }

    response.appendResponseLine(lines.join('\n'));
  },
});
