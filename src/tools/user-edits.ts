/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import z from 'zod';

import {ToolCategories} from './categories.js';
import {defineTool} from './ToolDefinition.js';

export const listUserEdits = defineTool({
  name: 'list_user_edits',
  description:
    'Lists recent visual edits the human performed using the MCP Selection DevTools extension.',
  annotations: {
    title: 'User Edits',
    category: ToolCategories.OVERLAY,
    readOnlyHint: true,
  },
  schema: {
    limit: z.number().int().min(1).max(20).default(10).describe('Maximum number of edits to return'),
    summarize: z.boolean().default(true).describe('Return human-readable summaries instead of raw JSON'),
  },
  handler: async (request, response, context) => {
    const edits = context.getUserEdits();
    if (!edits.length) {
      response.appendResponseLine(
        'No user-driven edits have been recorded yet. Ask the human to enable edit mode in the MCP Selection panel.',
      );
      return;
    }

    const slice = edits.slice(-request.params.limit);
    if (request.params.summarize) {
      for (const edit of slice) {
        response.appendResponseLine(
          `• ${new Date(edit.capturedAt).toISOString()} — ${edit.cssPath} (${edit.pageUrl})`,
        );
        const styleEntries = Object.entries(edit.styles);
        if (styleEntries.length) {
          response.appendResponseLine(
            styleEntries
              .map(([key, value]) => `    ${key}: ${value}`)
              .join('\n'),
          );
        }
        if (edit.summary) {
          response.appendResponseLine(`    → ${edit.summary}`);
        }
      }
    } else {
      response.appendResponseLine(JSON.stringify(slice, null, 2));
    }
  },
});
