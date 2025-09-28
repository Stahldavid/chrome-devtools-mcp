/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';
import path from 'node:path';

import type {SerializedAXNode} from 'puppeteer-core';
import z from 'zod';

import {ToolCategories} from './categories.js';
import {defineTool} from './ToolDefinition.js';

function getAXString(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object' && value !== null && 'value' in (value as Record<string, unknown>)) {
    return getAXString((value as Record<string, unknown>).value);
  }
  return '';
}

function extractAttributes(node: SerializedAXNode): Record<string, string> {
  const attributes: Record<string, string> = {};
  const candidates = [
    'disabled',
    'expanded',
    'focused',
    'modal',
    'multiline',
    'multiselectable',
    'readonly',
    'required',
    'selected',
    'checked',
    'pressed',
    'level',
    'valuemin',
    'valuemax',
    'autocomplete',
    'haspopup',
    'invalid',
    'orientation',
  ] as const;

  const rawNode = node as unknown as Record<string, unknown>;

  for (const candidate of candidates) {
    const value = rawNode[candidate];
    if (value === undefined || value === null) continue;
    attributes[candidate] = String(value);
  }

  // Also look at any additional properties if present
  const raw = rawNode;
  if ('properties' in raw && Array.isArray(raw.properties)) {
    for (const prop of raw.properties as Array<Record<string, unknown>>) {
      const name = typeof prop.name === 'string' ? prop.name.toLowerCase() : undefined;
      if (!name) continue;
      const value = getAXString(prop.value);
      if (value === '') continue;
      attributes[name] = value;
    }
  }

  return attributes;
}

// Helper function to generate stable SIDs from accessibility tree
function generateSID(node: SerializedAXNode, frameId = 'main', pathSegments: string[] = []): string {
  const role = getAXString(node.role);
  const name = getAXString(node.name);
  const description = getAXString(node.description);

  // Create a stable path for the node
  const axPath = path.posix.join('/', ...pathSegments);

  // Normalize the label for consistency
  const normalizedLabel = name.toLowerCase().trim().replace(/\s+/g, ' ');

  // Create hash input
  const hashInput = `${frameId}||${axPath}||${role}||${normalizedLabel}||${description}`;

  // Generate SHA-256 hash and encode as base64url
  const hash = crypto.createHash('sha256').update(hashInput).digest('base64url');

  return `sid_${hash.slice(0, 24)}`;
}

// Helper function to extract text snippet from node
function extractTextSnippet(node: SerializedAXNode, maxLength = 50): string | null {
  const name = getAXString(node.name);
  const description = getAXString(node.description);
  const value = getAXString(node.value);

  const text = name || description || value;
  if (!text) return null;

  return text.length > maxLength ? text.slice(0, maxLength) + '...' : text;
}

// Helper function to get element bounds (placeholder - would need CDP integration)
function getElementBounds(_node: SerializedAXNode): {x: number; y: number; width: number; height: number} {
  // In a real implementation, this would use CDP to get actual bounds
  // For now, return placeholder values
  return {x: 0, y: 0, width: 100, height: 20};
}

interface SemanticNodeBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface SemanticSnapshotNode {
  sid?: string;
  role?: string;
  label?: string;
  textSnippet?: string;
  bounds?: SemanticNodeBounds;
  frameId?: string;
}

interface SemanticQueryMatch {
  sid: string;
  role: string;
  label: string;
  confidence: number;
  score: number;
}

export const semSnapshot = defineTool({
  name: 'sem_snapshot',
  description: 'Create a semantic view of the page with stable SIDs (Semantic IDs) derived from the accessibility tree.',
  annotations: {
    title: 'Semantic Snapshot',
    category: ToolCategories.SEMANTIC,
    readOnlyHint: true,
  },
  schema: {
    scope: z.enum(['viewport', 'document']).default('document').describe('Scope of the snapshot'),
    within_sid: z.string().optional().describe('Limit snapshot to within this SID'),
    fields: z.array(z.string()).default(['sid', 'role', 'label', 'textSnippet', 'bounds', 'frameId']).describe('Fields to include in response'),
    max_nodes: z.number().int().min(1).default(5000).describe('Maximum number of nodes to return'),
    cursor: z.string().optional().describe('Pagination cursor'),
  },
  handler: async (request, response, context) => {
    const page = context.getSelectedPage();
    const params = request.params;

    try {
      // Get accessibility tree
      const accessibilityTree = await page.accessibility.snapshot({
        interestingOnly: false,
      });

      if (!accessibilityTree) {
        throw new Error('Failed to capture accessibility tree');
      }

      const snapshotId = `snap_${Math.random().toString(36).substring(2, 8)}`;
      const frameId = 'main'; // Simplified - in real implementation would get actual frame ID
      const nodes: SemanticSnapshotNode[] = [];
      const targetSid = params.within_sid;

      // Process accessibility tree recursively
      const processNode = (node: SerializedAXNode, pathSegments: string[] = [], isWithinScope = false) => {
        const sid = generateSID(node, frameId, pathSegments);
        const role = getAXString(node.role);
        const label = getAXString(node.name);
        const textSnippet = extractTextSnippet(node);
        const bounds = getElementBounds(node);

        const matchesTarget = targetSid ? sid === targetSid : true;
        const includeNode = targetSid ? isWithinScope || matchesTarget : true;
        const nextScope = targetSid ? isWithinScope || matchesTarget : true;

        if (includeNode && (role || label || textSnippet)) {
          const nodeData: SemanticSnapshotNode = {};
          if (params.fields.includes('sid')) nodeData.sid = sid;
          if (params.fields.includes('role')) nodeData.role = role;
          if (params.fields.includes('label')) nodeData.label = label;
          if (params.fields.includes('textSnippet') && textSnippet) nodeData.textSnippet = textSnippet;
          if (params.fields.includes('bounds')) nodeData.bounds = bounds;
          if (params.fields.includes('frameId')) nodeData.frameId = frameId;
          nodes.push(nodeData);
        }

        const children = node.children || [];
        if (children.length === 0) {
          return;
        }

        if (nodes.length >= params.max_nodes * 5) {
          return;
        }

        for (let i = 0; i < children.length; i++) {
          const child = children[i];
          const childRole = getAXString(child.role) || 'node';
          processNode(child, [...pathSegments, `${childRole}[${i}]`], nextScope);
        }
      };

      processNode(accessibilityTree);

      // Apply pagination if cursor is provided
      let startIndex = 0;
      if (params.cursor) {
        try {
          startIndex = parseInt(params.cursor, 10);
        } catch {
          startIndex = 0;
        }
      }

      const endIndex = Math.min(startIndex + params.max_nodes, nodes.length);
      const pageNodes = nodes.slice(startIndex, endIndex);
      
      const nextCursor = endIndex < nodes.length ? endIndex.toString() : null;

      const result = {
        snapshot_id: snapshotId,
        nodes: pageNodes,
        next_cursor: nextCursor,
      };

      response.appendResponseLine(`Created semantic snapshot: ${snapshotId}`);
      response.appendResponseLine(`Found ${nodes.length} semantic nodes`);
      response.appendResponseLine(`Returning nodes ${startIndex} to ${endIndex - 1}`);
      response.appendResponseLine(`Result: ${JSON.stringify(result, null, 2)}`);

    } catch (error) {
      throw new Error(`Failed to create semantic snapshot: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
});

export const semQuery = defineTool({
  name: 'sem_query',
  description: 'Search for elements by semantic properties (role, label, text, attributes). Returns matching SIDs.',
  annotations: {
    title: 'Semantic Query',
    category: ToolCategories.SEMANTIC,
    readOnlyHint: true,
  },
  schema: {
    role: z.string().optional().describe('Filter by ARIA role'),
    label: z.string().optional().describe('Filter by accessible label/name'),
    text: z.string().optional().describe('Filter by text content'),
    attributes: z.record(z.string()).optional().describe('Filter by ARIA attributes'),
    within_sid: z.string().optional().describe('Search within this SID only'),
    rank_by: z.enum(['semantic_score', 'proximity', 'visibility']).default('semantic_score').describe('Ranking method'),
    multiple: z.boolean().default(false).describe('Return multiple matches'),
    max: z.number().int().min(1).default(10).describe('Maximum results'),
    explain: z.boolean().default(false).describe('Include matching explanations'),
  },
  handler: async (request, response, context) => {
    const page = context.getSelectedPage();
    const params = request.params;

    try {
      // Get accessibility tree
      const accessibilityTree = await page.accessibility.snapshot({
        interestingOnly: false,
      });

      if (!accessibilityTree) {
        throw new Error('Failed to capture accessibility tree for querying');
      }

      const frameId = 'main';
      const matches: SemanticQueryMatch[] = [];
      const explanations: string[] = [];
      const targetSid = params.within_sid;

      // Process accessibility tree recursively
      const searchNode = (node: SerializedAXNode, pathSegments: string[] = [], isWithinScope = false) => {
        const sid = generateSID(node, frameId, pathSegments);
        const role = getAXString(node.role);
        const label = getAXString(node.name);
        const description = getAXString(node.description);
        const value = getAXString(node.value);
        const attributes = extractAttributes(node);

        const matchesTarget = targetSid ? sid === targetSid : true;
        const includeNode = targetSid ? isWithinScope || matchesTarget : true;
        const nextScope = targetSid ? isWithinScope || matchesTarget : true;

        if (includeNode) {
          let score = 0;
          const matchReasons: string[] = [];

          // Role matching
          if (params.role) {
            if (role.toLowerCase().includes(params.role.toLowerCase())) {
              score += 50;
              matchReasons.push(`role=${role}`);
            }
          }

          // Label matching
          if (params.label) {
            const searchLabel = params.label.toLowerCase();
            if (label.toLowerCase().includes(searchLabel)) {
              score += 40;
              matchReasons.push(`label≈${label}`);
            } else if (description.toLowerCase().includes(searchLabel)) {
              score += 30;
              matchReasons.push(`description≈${description}`);
            }
          }

          // Text content matching
          if (params.text) {
            const searchText = params.text.toLowerCase();
            const allText = `${label} ${description} ${value}`.toLowerCase();
            if (allText.includes(searchText)) {
              score += 35;
              matchReasons.push(`text≈${params.text}`);
            }
          }

          // Attributes matching
          if (params.attributes) {
            for (const [attr, expectedValue] of Object.entries(params.attributes)) {
              const lowerAttr = attr.toLowerCase();
              const actualValue = attributes[lowerAttr];
              if (actualValue && actualValue.toLowerCase() === expectedValue.toLowerCase()) {
                score += 20;
                matchReasons.push(`${attr}=${actualValue}`);
              }
            }
          }

          if (score > 0 && (role || label || description)) {
            const confidence = Math.min(score / 100, 1);
            matches.push({
              sid,
              role,
              label,
              confidence: Math.round(confidence * 100) / 100,
              score,
            });

            if (params.explain) {
              explanations.push(matchReasons.join(',') || '');
            }
          }
        }

        const children = node.children || [];
        if (children.length === 0) {
          return;
        }

        for (let i = 0; i < children.length; i++) {
          const child = children[i];
          const childRole = getAXString(child.role) || 'node';
          searchNode(child, [...pathSegments, `${childRole}[${i}]`], nextScope);
        }
      };

      searchNode(accessibilityTree);

      // Sort by ranking method
      switch (params.rank_by) {
        case 'semantic_score':
          matches.sort((a, b) => b.score - a.score);
          break;
        case 'proximity':
          // Simplified proximity - in real implementation would consider position
          matches.sort((a, b) => a.sid.localeCompare(b.sid));
          break;
        case 'visibility':
          // Placeholder - would need actual visibility calculation
          matches.sort((a, b) => b.confidence - a.confidence);
          break;
      }

      // Limit results
      const limitedMatches = matches.slice(0, params.max);
      const sids = limitedMatches.map(m => m.sid);

      // Return single result if not multiple
      if (!params.multiple && limitedMatches.length > 0) {
        const bestMatch = limitedMatches[0];
        response.appendResponseLine(`Found best match: ${bestMatch.sid} (confidence: ${bestMatch.confidence})`);
        response.appendResponseLine(`Result: ${JSON.stringify({
          sids: [bestMatch.sid],
          elements: [bestMatch],
          explanations: params.explain ? [explanations[0]] : undefined,
        }, null, 2)}`);
      } else {
        response.appendResponseLine(`Found ${matches.length} matches, returning top ${limitedMatches.length}`);
        response.appendResponseLine(`Result: ${JSON.stringify({
          sids,
          elements: limitedMatches,
          explanations: params.explain ? explanations.slice(0, limitedMatches.length) : undefined,
        }, null, 2)}`);
      }

    } catch (error) {
      throw new Error(`Failed to query semantic elements: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
});
