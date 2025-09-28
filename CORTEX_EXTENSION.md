# Cortex MCP Extension v0.1

This extension adds **visual AI↔human communication**, **semantic analysis (SIDs)**, and **deterministic execution** capabilities to the chrome-devtools-mcp server.

## New Tools Added

### Visual Overlay Tools
- **`overlay_annotate`** - Draw highlights (rings, boxes, underlines) with optional labels on page elements
- **`overlay_clear`** - Remove overlay annotations 
- **`overlay_pick_element`** - Enable interactive element picker for human selection (requires headed mode)

### Semantic Analysis Tools
- **`sem_snapshot`** - Create semantic view of page with stable SIDs from accessibility tree
- **`sem_query`** - Search elements by role, label, text content with semantic scoring

### Deterministic Execution Tools  
- **`time_freeze`** - Pause timers, animations, and RAF for deterministic execution
- **`time_resume`** - Resume normal time flow
- **`exec_step`** - Advance virtual time by N ticks
- **`view_screenshot`** - Take stabilized screenshots with PII redaction and masking

### Network Recording & Replay Tools
- **`net_record`** - Record network traffic with Service Worker bypass for reproducibility
- **`net_replay`** - Replay recorded network traces with exact or best-effort matching

### Governance & Audit Tools
- **`policy_scope`** - Set session policies for origins, capabilities, and limits
- **`policy_redact`** - Configure PII redaction rules for outputs
- **`audit_export`** - Export evidence bundles (screenshots, requests, logs) in JSON/SARIF/ZIP

## Key Features

### Stable Semantic IDs (SIDs)
SIDs are generated from the accessibility tree using a stable hash of:
- Frame ID + AX path + role + normalized label
- Format: `sid_<base64url-hash-24chars>`
- Reconciliation through semantic matching when elements change

### Visual Communication
- Overlay annotations for AI to highlight elements
- Element picker for human to select targets
- Support for multiple annotation shapes and persistence

### Deterministic Execution
- Virtual time control for consistent automation
- Animation freezing and step-by-step execution
- Stabilized screenshots with consistent timing

### Evidence & Governance
- Policy-based capability restrictions
- PII redaction for privacy protection
- Comprehensive audit trails and export

## Configuration

New CLI options:
- `--overlayEnabled` (default: true) - Enable visual overlay features
- `--determinismDefaults` (default: false) - Apply deterministic defaults
- `--bypassServiceWorkers` (default: true) - Bypass SW for network recording
- `--policyDefault` (default: deny_write) - Default policy for write operations

## Usage Examples

### AI Highlights Button for Human Click
```json
{"name": "sem_query", "args": {"role": "button", "label": "Submit"}}
→ {"sids": ["sid_abc..."]}

{"name": "overlay_annotate", "args": {"target": {"sid": "sid_abc..."}, "shape": "ring", "label": "Click here"}}
```

### Human Selects Field, AI Uses SID
```json
{"name": "overlay_pick_element", "args": {"hint": "Select email field"}}
→ {"picked": {"sid": "sid_def...", "role": "textbox"}}

{"name": "input_fill", "args": {"selector": "[data-sid='sid_def...']", "text": "user@example.com"}}
```

### Deterministic Screenshot Sequence
```json
{"name": "time_freeze", "args": {}}
{"name": "net_record", "args": {"mode": "strict"}}  
{"name": "view_screenshot", "args": {"stabilize_ms": 200, "redact_pii": true}}
{"name": "audit_export", "args": {"format": "json", "include": ["screenshots", "requests"]}}
```

## Implementation Notes

- Uses existing Chrome DevTools Protocol (CDP) - no browser modifications needed
- Overlays implemented via CDP `Overlay.*` methods with DOM fallback for rich annotations
- SID generation based on accessibility tree analysis
- Virtual time control via CDP `Emulation.setVirtualTimePolicy`
- Service Worker bypass via `Network.setBypassServiceWorker`

## Error Handling

- `headed_required` - Returned when headed mode is required but headless is used
- `policy_denied` - Capability blocked by active policy
- `timeout`, `rate_limited`, `invalid_param` - Standard error responses

## Future Extensions (F2)

- Intent-based automation with JSON-Logic planning
- Framework-aware selectors (React, Vue components)
- Heap snapshot capture and restoration for deeper undo
- Advanced network mocking and traffic shaping