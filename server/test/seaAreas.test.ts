import { describe, expect, it } from 'vitest';
import { marineWarningCovers } from '../src/util/seaAreas.js';

describe('marine warning coverage by headland arc', () => {
  const H = 'Howth Head';
  it('covers all coasts / Irish Sea', () => {
    expect(marineWarningCovers('Gale warning for all coasts of Ireland and on the Irish Sea', H)).toBe(true);
    expect(marineWarningCovers('Gale warning on the Irish Sea', H)).toBe(true);
  });
  it('east coast stretch includes Howth', () => {
    expect(marineWarningCovers('from Carlingford Lough to Wicklow Head', H)).toBe(true);
    expect(marineWarningCovers('from Belfast Lough to Carnsore Point', H)).toBe(true);
    expect(marineWarningCovers('from Malin Head to Carnsore Point', H)).toBe(true);
  });
  it('north-west and south-west stretches exclude Howth', () => {
    expect(marineWarningCovers('from Rossan Point to Bloody Foreland to Fair Head', H)).toBe(false);
    expect(marineWarningCovers('from Erris Head to Bloody Foreland to Belfast Lough', H)).toBe(false);
    expect(marineWarningCovers('from Carnsore Point to Mizen Head to Loop Head', H)).toBe(false);
  });
  it('anticlockwise phrasing is handled via the intermediate point', () => {
    // Wicklow Head → Howth Head → Carlingford Lough walked anticlockwise
    expect(marineWarningCovers('from Wicklow Head to Howth Head to Carlingford Lough', H)).toBe(true);
    expect(marineWarningCovers('from Loop Head to Mizen Head to Hook Head', H)).toBe(false);
  });
  it('unknown station headland never hides a warning', () => {
    expect(marineWarningCovers('from Rossan Point to Fair Head', 'Atlantis')).toBe(true);
  });
});
