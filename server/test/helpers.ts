import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rowsToObjects, type ErddapTable } from '../src/util/erddap.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const fixture = (name: string) => fs.readFileSync(path.join(here, 'fixtures', name), 'utf8');
export const fixtureJson = <T = any>(name: string) => JSON.parse(fixture(name)) as T;
export const erddapRows = (name: string) => rowsToObjects(fixtureJson<ErddapTable>(name));
