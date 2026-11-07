#!/usr/bin/env npx tsx
/** Allocate one dated MEM identity without reading or writing brain files. */
import { newMemId } from "./lib/mem-id.js";

console.log(newMemId());
