import { describe, expect, it } from 'vitest';
import { parseAdminArgs, parseOperatorMapping } from '../../scripts/admin/cli.js';

describe('Platform Admin CLI identity and arguments', () => {
  it('requires explicit local mode and validates supported operations', () => {
    expect(parseAdminArgs(['--local', 'grant', 'usr_01JCS9Y0S7R4XK3X2B8Q8H4V1A']))
      .toEqual({ local: true, operation: 'grant', target: 'usr_01JCS9Y0S7R4XK3X2B8Q8H4V1A' });
    expect(parseAdminArgs(['registration', 'off']))
      .toEqual({ local: false, operation: 'registration', setting: 'off' });
  });

  it('does not accept caller-supplied operator identities', () => {
    expect(() => parseAdminArgs(['grant', 'usr_01JCS9Y0S7R4XK3X2B8Q8H4V1A', '--as', 'usr_01JCS9Y0S7R4XK3X2B8Q8H4V1B']))
      .toThrow('INVALID_ARGUMENT');
    expect(() => parseAdminArgs(['--as', 'usr_01JCS9Y0S7R4XK3X2B8Q8H4V1A', 'grant', 'usr_01JCS9Y0S7R4XK3X2B8Q8H4V1A']))
      .toThrow('INVALID_ARGUMENT');
  });

  it('accepts only an OS-user to valid SprintHub user ID mapping', () => {
    expect(parseOperatorMapping('{"operator":"usr_01JCS9Y0S7R4XK3X2B8Q8H4V1A"}'))
      .toEqual({ operator: 'usr_01JCS9Y0S7R4XK3X2B8Q8H4V1A' });
    expect(() => parseOperatorMapping('{"operator":"admin"}')).toThrow('OPERATOR_FORBIDDEN');
    expect(() => parseOperatorMapping('[]')).toThrow('OPERATOR_FORBIDDEN');
  });
});
