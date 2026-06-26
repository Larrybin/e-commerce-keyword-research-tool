const context = [
  'e-commerce-keyword-research-tool workflow reminder:',
  '- Semrush remains before agent预判断; Bing/SERP/formal Agent remain after it.',
  '- agent预判断 uses the ecommerce-keyword-prefilter skill and is judged by Codex keyword-by-keyword.',
  '- Process keyword rows; later stages require 关键词 plus agent预判断=继续.',
  '- Batch write only the agent预判断 column after decisions are made.',
  '- Do not write 机器筛选状态 or 机器筛选原因 in this step.',
  '- Do not treat npm run agent:prefilter as the canonical full-run judgment path unless the user explicitly accepts the deterministic shortcut.',
].join('\n');

process.stdout.write(`${JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext: context,
  },
})}\n`);
