import { describe, expect, it } from 'vitest';
import { assignLayerNames } from '../../src/files/layer-names.js';

describe('assignLayerNames', () => {
  it('replaces every layer-invalid character with an underscore', () => {
    expect(assignLayerNames(['a<b>c/d\\e"f:g;h?i*j|k=l,m.hpgl'])).toEqual([
      'a_b_c_d_e_f_g_h_i_j_k_l_m',
    ]);
  });

  it('removes only the last extension', () => {
    expect(assignLayerNames(['archive.part.hpgl'])).toEqual(['archive.part']);
  });

  it('falls back to layer for an empty name', () => {
    expect(assignLayerNames([''])).toEqual(['layer']);
  });

  it('suffixes duplicates case-insensitively with _2 and _3', () => {
    expect(assignLayerNames(['sample.hpgl', 'SAMPLE.plt', 'Sample.H01'])).toEqual([
      'sample',
      'SAMPLE_2',
      'Sample_3',
    ]);
  });

  it('matches the specified sanitized layer-name example', () => {
    expect(assignLayerNames(['部品:H01.H01', 'sample.hpgl', 'SAMPLE.plt', '***.hpg']))
      .toEqual(['部品_H01', 'sample', 'SAMPLE_2', '___']);
  });
});
