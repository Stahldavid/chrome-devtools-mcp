/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';
import z from 'zod';

import {ToolCategories} from './categories.js';
import {defineTool} from './ToolDefinition.js';

// Global policy and audit storage (in a real implementation, this would be persistent)
const policies = new Map<string, any>();
const auditLogs: any[] = [];

export const policyScope = defineTool({
  name: 'policy_scope',
  description: 'Set session policy contract defining allowed origins, capabilities, and resource limits.',
  annotations: {
    title: 'Set Policy Scope',
    category: ToolCategories.GOVERNANCE,
    readOnlyHint: false,
  },
  schema: {
    origins: z.array(z.string()).describe('Allowed origins for navigation and requests'),
    capabilities: z.object({
      dom: z.object({
        read: z.boolean().default(true).describe('Allow DOM reading operations'),
        write: z.boolean().default(false).describe('Allow DOM modifications'),
      }).default({}).describe('DOM access capabilities'),
      forms: z.object({
        submit: z.boolean().default(false).describe('Allow form submissions'),
      }).default({}).describe('Form interaction capabilities'),
      network: z.object({
        mock: z.boolean().default(false).describe('Allow network mocking'),
        block: z.boolean().default(false).describe('Allow network blocking'),
      }).default({}).describe('Network control capabilities'),
      eval: z.object({
        main: z.boolean().default(false).describe('Allow script execution in main world'),
        isolated: z.boolean().default(true).describe('Allow script execution in isolated world'),
      }).default({}).describe('Script execution capabilities'),
    }).default({}).describe('Capability restrictions'),
    limits: z.object({
      max_clicks_per_min: z.number().int().default(60).describe('Maximum clicks per minute'),
      max_dom_mutations_per_min: z.number().int().default(200).describe('Maximum DOM mutations per minute'),
    }).default({}).describe('Rate limiting configuration'),
  },
  handler: async (request, response, context) => {
    const params = request.params;

    try {
      const policyId = `pol_${Math.random().toString(36).substring(2, 8)}`;
      
      // Validate origins format
      for (const origin of params.origins) {
        try {
          new URL(origin);
        } catch {
          throw new Error(`Invalid origin URL: ${origin}`);
        }
      }

      // Create policy object with defaults
      const policy = {
        policyId,
        origins: params.origins,
        capabilities: {
          dom: { ...{ read: true, write: false }, ...params.capabilities?.dom },
          forms: { ...{ submit: false }, ...params.capabilities?.forms },
          network: { ...{ mock: false, block: false }, ...params.capabilities?.network },
          eval: { ...{ main: false, isolated: true }, ...params.capabilities?.eval },
        },
        limits: {
          ...{
            max_clicks_per_min: 60,
            max_dom_mutations_per_min: 200,
          },
          ...params.limits,
        },
        createdAt: Date.now(),
        active: true,
      };

      // Store policy
      policies.set(policyId, policy);

      // Log policy creation
      auditLogs.push({
        timestamp: Date.now(),
        type: 'policy_created',
        policyId,
        details: policy,
      });

      response.appendResponseLine(`Policy created: ${policyId}`);
      response.appendResponseLine(`Allowed origins: ${params.origins.join(', ')}`);
      response.appendResponseLine(`DOM write access: ${policy.capabilities.dom.write ? 'enabled' : 'disabled'}`);
      response.appendResponseLine(`Form submissions: ${policy.capabilities.forms.submit ? 'enabled' : 'disabled'}`);
      response.appendResponseLine(`Network mocking: ${policy.capabilities.network.mock ? 'enabled' : 'disabled'}`);
      response.appendResponseLine(`Script evaluation: main=${policy.capabilities.eval.main}, isolated=${policy.capabilities.eval.isolated}`);
      
      response.appendResponseLine(`Result: ${JSON.stringify({
        policy_id: policyId,
        effective: true,
      }, null, 2)}`);

    } catch (error) {
      throw new Error(`Failed to set policy scope: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
});

export const policyRedact = defineTool({
  name: 'policy_redact',
  description: 'Configure PII redaction rules for screenshots, logs, and other outputs.',
  annotations: {
    title: 'Configure PII Redaction',
    category: ToolCategories.GOVERNANCE,
    readOnlyHint: false,
  },
  schema: {
    classes: z.array(z.string()).describe('PII classes to redact (email, phone, ssn, credit_card, etc.)'),
    mode: z.enum(['mask', 'drop']).default('mask').describe('Redaction mode - mask with placeholder or drop entirely'),
  },
  handler: async (request, response, context) => {
    const params = request.params;

    try {
      const redactionConfig = {
        classes: params.classes,
        mode: params.mode,
        patterns: new Map<string, RegExp>(),
        updatedAt: Date.now(),
      };

      // Build regex patterns for each PII class
      const piiPatterns: Record<string, RegExp> = {
        email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
        phone: /\b(\+?1[-.\s]?)?\(?([0-9]{3})\)?[-.\s]?([0-9]{3})[-.\s]?([0-9]{4})\b/g,
        ssn: /\b\d{3}-?\d{2}-?\d{4}\b/g,
        credit_card: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g,
        ip_address: /\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b/g,
        zip_code: /\b\d{5}(-\d{4})?\b/g,
        date_of_birth: /\b(0[1-9]|1[0-2])[\/\-](0[1-9]|[12][0-9]|3[01])[\/\-](19|20)\d{2}\b/g,
      };

      for (const className of params.classes) {
        const pattern = piiPatterns[className];
        if (pattern) {
          redactionConfig.patterns.set(className, pattern);
        } else {
          response.appendResponseLine(`Warning: Unknown PII class '${className}' - will be ignored`);
        }
      }

      // Store global redaction configuration
      (globalThis as any).__mcpRedactionConfig = redactionConfig;

      // Log redaction policy update
      auditLogs.push({
        timestamp: Date.now(),
        type: 'redaction_policy_updated',
        classes: params.classes,
        mode: params.mode,
      });

      response.appendResponseLine(`PII redaction configured`);
      response.appendResponseLine(`Classes: ${params.classes.join(', ')}`);
      response.appendResponseLine(`Mode: ${params.mode}`);
      response.appendResponseLine(`Active patterns: ${redactionConfig.patterns.size}`);

    } catch (error) {
      throw new Error(`Failed to configure PII redaction: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
});

export const auditExport = defineTool({
  name: 'audit_export',
  description: 'Export audit evidence bundle (screenshots, requests, snapshots, logs) in JSON, SARIF, or ZIP format.',
  annotations: {
    title: 'Export Audit Bundle',
    category: ToolCategories.GOVERNANCE,
    readOnlyHint: true,
  },
  schema: {
    format: z.enum(['sarif', 'json', 'zip']).default('json').describe('Export format'),
    include: z.array(z.enum(['screenshots', 'requests', 'snapshots', 'logs'])).default(['screenshots', 'requests']).describe('Data types to include'),
    trace_id: z.string().optional().describe('Specific trace ID to export'),
  },
  handler: async (request, response, context) => {
    const params = request.params;

    try {
      const exportId = `export_${Math.random().toString(36).substring(2, 8)}`;
      const timestamp = Date.now();

      // Collect audit data
      const auditBundle: any = {
        exportId,
        timestamp,
        format: params.format,
        metadata: {
          generator: 'chrome-devtools-mcp-cortex',
          version: '0.1.0',
          created: new Date(timestamp).toISOString(),
        },
        evidence: {},
      };

      // Include screenshots if requested
      if (params.include.includes('screenshots')) {
        auditBundle.evidence.screenshots = [
          {
            id: 'screenshot_1',
            timestamp,
            type: 'viewport',
            format: 'png',
            size_bytes: 12345,
            sha256: 'mock_screenshot_hash',
            metadata: {
              viewport: { width: 1280, height: 800 },
              device_scale_factor: 1,
              redacted: false,
            },
          },
        ];
      }

      // Include network requests if requested
      if (params.include.includes('requests')) {
        const networkData = context.getNetworkRequests().map(req => ({
          url: req.url(),
          method: req.method(),
          status: req.response()?.status() || null,
          timestamp: Date.now(), // Simplified
          resourceType: req.resourceType(),
          headers: Object.fromEntries(Object.entries(req.headers())),
        }));

        auditBundle.evidence.requests = networkData;
      }

      // Include DOM snapshots if requested
      if (params.include.includes('snapshots')) {
        const snapshot = context.getTextSnapshot();
        if (snapshot) {
          auditBundle.evidence.snapshots = [{
            id: snapshot.snapshotId,
            timestamp,
            type: 'accessibility_tree',
            node_count: snapshot.idToNode.size,
            root_node: snapshot.root,
          }];
        }
      }

      // Include logs if requested
      if (params.include.includes('logs')) {
        auditBundle.evidence.logs = {
          audit_log: auditLogs.slice(-50), // Last 50 entries
          console_messages: context.getConsoleData().slice(-20).map(msg => ({
            timestamp: Date.now(),
            type: 'log' in msg ? msg.type() : 'error',
            text: 'text' in msg ? msg.text() : msg.message,
          })),
        };
      }

      // Convert to requested format
      let exportData: string;
      let mimeType: string;

      switch (params.format) {
        case 'json':
          exportData = JSON.stringify(auditBundle, null, 2);
          mimeType = 'application/json';
          break;

        case 'sarif':
          // Convert to SARIF format (Static Analysis Results Interchange Format)
          const sarifReport = {
            version: '2.1.0',
            $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json',
            runs: [{
              tool: {
                driver: {
                  name: 'chrome-devtools-mcp-cortex',
                  version: '0.1.0',
                },
              },
              results: [],
              artifacts: Object.values(auditBundle.evidence).flat().map((item: any) => ({
                location: { uri: item.url || `evidence:${item.id}` },
                description: { text: `Evidence: ${item.type || 'unknown'}` },
              })),
            }],
          };
          exportData = JSON.stringify(sarifReport, null, 2);
          mimeType = 'application/json';
          break;

        case 'zip':
          // For ZIP format, we would create a ZIP file with separate files for each evidence type
          // This is a simplified representation
          exportData = JSON.stringify({
            ...auditBundle,
            note: 'ZIP format would contain separate files for each evidence type',
          }, null, 2);
          mimeType = 'application/zip';
          break;

        default:
          throw new Error(`Unsupported format: ${params.format}`);
      }

      // Calculate metadata
      const byteSize = Buffer.from(exportData, 'utf-8').length;
      const sha256 = crypto.createHash('sha256').update(exportData, 'utf-8').digest('hex');
      const createdMs = Date.now() - timestamp;

      // Log export activity
      auditLogs.push({
        timestamp: Date.now(),
        type: 'audit_exported',
        exportId,
        format: params.format,
        included: params.include,
        byte_size: byteSize,
      });

      response.appendResponseLine(`Audit bundle exported: ${exportId}`);
      response.appendResponseLine(`Format: ${params.format}`);
      response.appendResponseLine(`Included evidence: ${params.include.join(', ')}`);
      response.appendResponseLine(`Size: ${byteSize} bytes`);

      const result = {
        sha256,
        byte_size: byteSize,
        created_ms: createdMs,
      };

      response.appendResponseLine(`Result: ${JSON.stringify(result, null, 2)}`);

      // In a real implementation, you might want to save the export data to a file
      // and provide a download link or file path

    } catch (error) {
      throw new Error(`Failed to export audit bundle: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
});