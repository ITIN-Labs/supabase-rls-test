// Checked by tsc, never run: fails the type check if the public types change shape.
import { expectTypeOf } from 'expect-type';
import {
  createTestDb,
  RlsTestError,
  type QueryResult,
  type RlsTestErrorCode,
  type Session,
  type TestDb,
} from '../src/index.ts';

expectTypeOf(createTestDb).parameter(0).toEqualTypeOf<{ migrations: string }>();
expectTypeOf(createTestDb).returns.resolves.toEqualTypeOf<TestDb>();

expectTypeOf<TestDb['as']>().returns.toEqualTypeOf<Session>();
expectTypeOf<TestDb['anon']>().toEqualTypeOf<Session>();
expectTypeOf<TestDb['createUser']>().returns.resolves.toBeString();
expectTypeOf<Session['denied']>().returns.resolves.toBeBoolean();

declare const session: Session;
expectTypeOf(session.query<{ id: number }>('select 1 id')).resolves.toEqualTypeOf<QueryResult<{ id: number }>>();
expectTypeOf(session.query('select 1')).resolves.toEqualTypeOf<QueryResult<Record<string, unknown>>>();

expectTypeOf<RlsTestError['code']>().toEqualTypeOf<RlsTestErrorCode>();
expectTypeOf<RlsTestErrorCode>().toEqualTypeOf<'INVALID_OPTIONS' | 'MIGRATION_FAILED' | 'NO_MATCHING_ROWS'>();

// @ts-expect-error unknown options are a type error as well as a runtime one
void createTestDb({ migrations: 'x', seed: 'y' });
