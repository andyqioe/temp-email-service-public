export const PARSER_MODULE_NAMES = ['otp', 'jagex', 'echo', 'fail', 'spin'] as const;
export type ParserModuleName = typeof PARSER_MODULE_NAMES[number];
