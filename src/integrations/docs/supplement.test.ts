import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { fillSupplementProtocol } from './supplement';

// Round-trip through Nicole's real template: fill, then re-read the buffer and
// assert the values landed in the right cells and her grid formatting survived.
async function load(buf: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
  return wb.worksheets[0];
}

describe('fillSupplementProtocol', () => {
  it('writes rows into the grid and preserves the header + borders', async () => {
    const buf = await fillSupplementProtocol({
      rows: [
        {
          name: 'Cataplex B',
          specialInstructions: 'with food',
          schedule: { breakfast: 'X', dinner: 'X' },
          bottleQuantity: 1,
          source: 'Here',
        },
        {
          name: 'Zypan',
          schedule: { lunch: '2' },
          bottleQuantity: 2,
          source: 'Fullscript',
        },
      ],
      notes: 'Recheck in 2 weeks',
      toDo: 'Order Zypan',
    });

    const ws = await load(buf);
    // Header untouched.
    expect(ws.getCell('B4').value).toBe('SUPPLEMENTS');
    // Row 1 (grid starts at row 5).
    expect(ws.getCell('B5').value).toBe('Cataplex B');
    expect(ws.getCell('C5').value).toBe('with food');
    expect(ws.getCell('E5').value).toBe('X'); // breakfast
    expect(ws.getCell('I5').value).toBe('X'); // dinner
    expect(ws.getCell('K5').value).toBe(1);
    expect(ws.getCell('L5').value).toBe('Here');
    // Row 2.
    expect(ws.getCell('B6').value).toBe('Zypan');
    expect(ws.getCell('G6').value).toBe('2'); // lunch
    expect(ws.getCell('L6').value).toBe('Fullscript');
    // Empty slots stay empty.
    expect(ws.getCell('D5').value).toBeNull();
    // Border survived (terracotta grid).
    expect(ws.getCell('B5').border?.left?.style).toBe('thin');
    // NOTES/TO DO written below the grid.
    expect(ws.getCell('B23').value).toBe('Recheck in 2 weeks');
    expect(ws.getCell('H23').value).toBe('Order Zypan');
  });

  it('grows the grid without clobbering the NOTES block on overflow', async () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ name: `Supp ${i + 1}` }));
    const buf = await fillSupplementProtocol({ rows, notes: 'below' });
    const ws = await load(buf);
    expect(ws.getCell('B5').value).toBe('Supp 1');
    expect(ws.getCell('B24').value).toBe('Supp 20'); // 5 + 19
    // NOTES header pushed down (was row 22, +3 overflow rows = row 25).
    expect(ws.getCell('B25').value).toBe('NOTES');
    expect(ws.getCell('B26').value).toBe('below');
  });
});
