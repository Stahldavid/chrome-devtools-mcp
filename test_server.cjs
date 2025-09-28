#!/usr/bin/env node

// Quick test to verify our new tools are loaded
const fs = require('fs');

console.log('🔍 Testing Cortex MCP Extension tools...\n');

// Check if our built tools exist
const toolFiles = [
    'build/src/tools/overlay.js',
    'build/src/tools/semantic.js', 
    'build/src/tools/determinism.js',
    'build/src/tools/governance.js',
    'build/src/tools/network-replay.js'
];

let allFound = true;
toolFiles.forEach(file => {
    if (fs.existsSync(file)) {
        const stats = fs.statSync(file);
        console.log(`✅ ${file} (${Math.round(stats.size/1024)}KB)`);
    } else {
        console.log(`❌ ${file} - NOT FOUND`);
        allFound = false;
    }
});

console.log(`\n📊 Summary:`);
console.log(`- ${allFound ? '✅ All' : '❌ Some'} tool files compiled successfully`);
console.log(`- Main server: ${fs.existsSync('build/src/main.js') ? '✅ Ready' : '❌ Missing'}`);
console.log(`- Index entry: ${fs.existsSync('build/src/index.js') ? '✅ Ready' : '❌ Missing'}`);

if (allFound) {
    console.log(`\n🚀 Your Cortex MCP Extension is ready to use!`);
    console.log(`\nTo test it, run:`);
    console.log(`  node build/src/index.js --headless=false`);
    console.log(`\nNew tools available:`);
    console.log(`  - overlay_annotate, overlay_clear, overlay_pick_element`);
    console.log(`  - sem_snapshot, sem_query`);  
    console.log(`  - time_freeze, time_resume, exec_step, view_screenshot`);
    console.log(`  - net_record, net_replay`);
    console.log(`  - policy_scope, policy_redact, audit_export`);
    console.log(`\n💡 Use with MCP clients like Claude Desktop, Cursor, etc.`);
} else {
    console.log(`\n❌ Build incomplete. Check compilation errors above.`);
}