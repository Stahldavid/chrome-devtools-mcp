/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import crypto from 'node:crypto';
import z from 'zod';
import { ToolCategories } from './categories.js';
import { defineTool } from './ToolDefinition.js';
// Helper function to generate stable SIDs from accessibility tree
function generateSID(node, frameId = 'main', path = []) {
    const role = node.role?.value || '';
    const name = node.name?.value || '';
    const description = node.description?.value || '';
    // Create a stable path for the node
    const axPath = path.join('/');
    // Normalize the label for consistency
    const normalizedLabel = name.toLowerCase().trim().replace(/\s+/g, ' ');
    // Create hash input
    const hashInput = `${frameId}||${axPath}||${role}||${normalizedLabel}||${description}`;
    // Generate SHA-256 hash and encode as base64url
    const hash = crypto.createHash('sha256').update(hashInput).digest('base64url');
    return `sid_${hash.slice(0, 24)}`;
}
// Helper function to extract text snippet from node
function extractTextSnippet(node, maxLength = 50) {
    const name = node.name?.value || '';
    const description = node.description?.value || '';
    const value = node.value?.value || '';
    const text = name || description || value;
    if (!text)
        return null;
    return text.length > maxLength ? text.slice(0, maxLength) + '...' : text;
}
// Helper function to get element bounds (placeholder - would need CDP integration)
function getElementBounds(node) {
    // In a real implementation, this would use CDP to get actual bounds
    // For now, return placeholder values
    return { x: 0, y: 0, width: 100, height: 20 };
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
                interestingOnly: true,
            });
            if (!accessibilityTree) {
                throw new Error('Failed to capture accessibility tree');
            }
            const snapshotId = `snap_${Math.random().toString(36).substring(2, 8)}`;
            const frameId = 'main'; // Simplified - in real implementation would get actual frame ID
            const nodes = [];
            // Process accessibility tree recursively
            const processNode = (node, path = []) => {
                if (nodes.length >= params.max_nodes)
                    return;
                const sid = generateSID(node, frameId, path);
                const role = node.role?.value || '';
                const label = node.name?.value || '';
                const textSnippet = extractTextSnippet(node);
                const bounds = getElementBounds(node);
                // Filter by within_sid if specified
                if (params.within_sid && !sid.includes(params.within_sid)) {
                    return;
                }
                // Build node object with requested fields
                const nodeData = {};
                if (params.fields.includes('sid'))
                    nodeData.sid = sid;
                if (params.fields.includes('role'))
                    nodeData.role = role;
                if (params.fields.includes('label'))
                    nodeData.label = label;
                if (params.fields.includes('textSnippet'))
                    nodeData.textSnippet = textSnippet;
                if (params.fields.includes('bounds'))
                    nodeData.bounds = bounds;
                if (params.fields.includes('frameId'))
                    nodeData.frameId = frameId;
                // Only include nodes with meaningful content
                if (role && (label || textSnippet)) {
                    nodes.push(nodeData);
                }
                // Process children
                if (node.children) {
                    for (let i = 0; i < node.children.length; i++) {
                        processNode(node.children[i], [...path, `${role}[${i}]`]);
                    }
                }
            };
            processNode(accessibilityTree);
            // Apply pagination if cursor is provided
            let startIndex = 0;
            if (params.cursor) {
                try {
                    startIndex = parseInt(params.cursor, 10);
                }
                catch {
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
        }
        catch (error) {
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
                interestingOnly: true,
            });
            if (!accessibilityTree) {
                throw new Error('Failed to capture accessibility tree for querying');
            }
            const frameId = 'main';
            const matches = [];
            const explanations = [];
            // Process accessibility tree recursively
            const searchNode = (node, path = []) => {
                const sid = generateSID(node, frameId, path);
                const role = node.role?.value || '';
                const label = node.name?.value || '';
                const description = node.description?.value || '';
                const value = node.value?.value || '';
                let score = 0;
                let matchReasons = [];
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
                    }
                    else if (description.toLowerCase().includes(searchLabel)) {
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
                // Attributes matching (simplified - in real implementation would check actual ARIA attributes)
                if (params.attributes) {
                    for (const [attr, expectedValue] of Object.entries(params.attributes)) {
                        // Placeholder matching logic
                        if (attr === 'required' && expectedValue === 'true') {
                            score += 20;
                            matchReasons.push(`${attr}=${expectedValue}`);
                        }
                    }
                }
                // Within SID filtering
                if (params.within_sid && !sid.startsWith(params.within_sid)) {
                    score = 0; // Exclude if not within specified SID
                }
                // Only consider matches with some score and meaningful content
                if (score > 0 && (role || label)) {
                    const confidence = Math.min(score / 100, 1);
                    matches.push({
                        sid,
                        role,
                        label,
                        confidence: Math.round(confidence * 100) / 100,
                        score,
                    });
                    if (params.explain) {
                        explanations.push(matchReasons.join(','));
                    }
                }
                // Process children
                if (node.children) {
                    for (let i = 0; i < node.children.length; i++) {
                        searchNode(node.children[i], [...path, `${role}[${i}]`]);
                    }
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
            }
            else {
                response.appendResponseLine(`Found ${matches.length} matches, returning top ${limitedMatches.length}`);
                response.appendResponseLine(`Result: ${JSON.stringify({
                    sids,
                    elements: limitedMatches,
                    explanations: params.explain ? explanations.slice(0, limitedMatches.length) : undefined,
                }, null, 2)}`);
            }
        }
        catch (error) {
            throw new Error(`Failed to query semantic elements: ${error instanceof Error ? error.message : String(error)}`);
        }
    },
});
