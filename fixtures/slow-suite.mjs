const t = Date.now();
while (Date.now() - t < 900) { /* deliberately slow, for the timeout tests */ }
process.exit(0);
