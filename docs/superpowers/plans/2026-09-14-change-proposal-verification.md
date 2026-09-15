# Change Proposal + Verification Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 기존 삽입 중심 retype 흐름에 사람이 직접 수행하는 줄 단위 교체·삭제 제안과 VS Code diagnostics 조회를 추가한다.

**Architecture:** `propose`는 그대로 유지하고 `propose_change`를 별도 MCP 도구로 둔다. `ghost.ts`의 단일 Session은 insert/change 모드를 모두 표현하되, 자동 문서 수정은 하지 않는다. diagnostics는 VS Code의 `languages.getDiagnostics`를 얇은 MCP adapter로 노출하고, 임의 프로세스 실행은 추가하지 않는다.

**Tech Stack:** TypeScript, VS Code Extension API, MCP Streamable HTTP, Node assert 기반 E2E 테스트

---

## 파일 구조

- Modify: `src/ghost.ts` — 기존 따라쓰기 Session에 교체 단계, 선택 영역 표시, change 결과를 추가한다.
- Modify: `src/server.ts` — `propose_change`와 `read_diagnostics` MCP 도구를 등록한다.
- Modify: `src/panel.ts` — Claude/Codex agent 규칙과 MCP 툴 이벤트 표시를 업데이트한다.
- Modify: `src/e2e/index.ts` — 새 MCP 툴의 RED/GREEN 통합 테스트를 추가한다.
- Modify: `README.md` — 새 MCP 툴과 직접 교체 흐름을 문서화한다.
- Create: `docs/superpowers/specs/2026-09-14-change-proposal-verification-design.md` — 승인된 범위와 오류 계약을 기록한다.
- Create: `docs/superpowers/plans/2026-09-14-change-proposal-verification.md` — 이 구현 계획을 기록한다.

### Task 1: 설계 문서와 기준선 고정

**Files:**
- Create: `docs/superpowers/specs/2026-09-14-change-proposal-verification-design.md`
- Create: `docs/superpowers/plans/2026-09-14-change-proposal-verification.md`

- [x] **Step 1: 설계와 계획 문서 작성**

  `propose_change`는 1-based inclusive 줄 범위와 `oldText`를 받으며, `read_diagnostics`는 현재/지정 파일의 diagnostics만 반환한다. 임의 shell 실행과 열 단위 diff는 제외한다.

- [x] **Step 2: 기준선 실행**

  Run: `npm test`

  Expected: `match: 모든 검사 통과`

### Task 2: Change Proposal RED

**Files:**
- Modify: `src/e2e/index.ts`

- [x] **Step 1: 툴 목록에 새 도구를 요구하는 테스트 추가**

  기존 목록 assertion을 다음으로 바꾼다.

  ```ts
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    'propose',
    'propose_change',
    'read_diagnostics',
    'read_viewport',
  ]);
  ```

- [x] **Step 2: 기존 선택 영역을 직접 입력으로 교체하는 테스트 추가**

  ```ts
  {
    const editor = await openDoc('const value = old;\nkeep();');
    const pending = client.callTool({
      name: 'propose_change',
      arguments: {
        startLine: 1,
        endLine: 1,
        oldText: 'const value = old;',
        text: 'const value = new;',
        why: '값의 기본값을 교체',
      },
    });
    await until(() => api.hasActive());
    await type('const value = new;');
    const result = parse<{ typed: boolean }>(await pending);
    assert.equal(result.typed, true);
    assert.equal(editor.document.getText(), 'const value = new;\nkeep();');
  }
  ```

- [x] **Step 3: 기존 영역 삭제 후 새 텍스트를 입력하는 테스트 추가**

  선택된 영역을 `deleteLeft`로 지운 다음 replacement를 `type`하고 `{ typed: true }`와 최종 문서를 확인한다.

- [x] **Step 4: stale 범위 테스트 추가**

  ```ts
  {
    await openDoc('const value = current;');
    const result = parse<{ typed: boolean; reason: string }>(
      await client.callTool({
        name: 'propose_change',
        arguments: {
          startLine: 1,
          endLine: 1,
          oldText: 'const value = old;',
          text: 'const value = new;',
          why: 'stale 범위',
        },
      })
    );
    assert.deepEqual(result, { typed: false, reason: 'stale' });
    assert.equal(api.hasActive(), false);
  }
  ```

- [x] **Step 5: RED 확인**

  Run: `npm run test:e2e`

  Expected: 새 툴이 등록되지 않아 툴 목록 assertion에서 실패한다. 실패 원인은 구현 누락이어야 하며 TypeScript 오류가 아니어야 한다.

### Task 3: Change Proposal GREEN

**Files:**
- Modify: `src/server.ts:63-148`
- Modify: `src/ghost.ts:8-269`

- [x] **Step 1: 줄 범위와 `oldText` 검증 구현**

  `startLine`과 `endLine`을 문서 범위로 변환하고, 범위 본문이 `oldText`와 다르면 `stale`을 반환한다. 일치하면 선택 영역을 만들고 change 모드 Session을 시작한다.

- [x] **Step 2: change 모드 Session 구현**

  기존 Session에 `kind: 'insert' | 'change'`, old range와 `changeStarted` 상태를 추가한다. 선택된 old range는 별도 decoration으로 표시하고, 첫 문서 변경 이후에만 target의 inline ghost를 표시한다.

- [x] **Step 3: 직접 교체와 삭제 후 입력 처리**

  전체 선택 영역이 새 텍스트로 대체된 경우 inserted text를 target 입력으로 판정한다. 영역이 삭제된 경우 anchor부터 새 입력을 판정한다. target 완료·cancel·timeout·abandon 결과는 기존 결과 계약을 재사용한다.

- [x] **Step 4: GREEN 확인**

  Run: `npm run test:e2e`

  Expected: 툴 목록, 직접 교체, 삭제 후 입력, stale 테스트가 통과한다.

### Task 4: Verification Loop RED

**Files:**
- Modify: `src/e2e/index.ts`

- [x] **Step 1: diagnostics 반환 테스트 추가**

  ```ts
  {
    const editor = await openDoc('const broken = true;');
    const collection = vscode.languages.createDiagnosticCollection('retype-test');
    collection.set(editor.document.uri, [
      new vscode.Diagnostic(
        new vscode.Range(0, 6, 0, 12),
        '검사용 오류',
        vscode.DiagnosticSeverity.Error
      ),
    ]);
    const result = parse<{
      diagnostics: { message: string; severity: string; startLine: number }[];
      counts: { error: number };
    }>(await client.callTool({ name: 'read_diagnostics', arguments: {} }));
    assert.equal(result.counts.error, 1);
    assert.deepEqual(result.diagnostics[0], {
      message: '검사용 오류',
      severity: 'error',
      startLine: 1,
      startCharacter: 6,
      endLine: 1,
      endCharacter: 12,
    });
    collection.dispose();
  }
  ```

- [x] **Step 2: RED 확인**

  Run: `npm run test:e2e`

  Expected: `read_diagnostics`가 등록되지 않아 tool call이 실패한다. 실패 원인은 구현 누락이어야 한다.

### Task 5: Verification Loop GREEN

**Files:**
- Modify: `src/server.ts:20-30,120-148`
- Modify: `src/panel.ts:7-10,147-155,201-215`

- [x] **Step 1: diagnostics 직렬화 구현**

  `vscode.languages.getDiagnostics(uri)`의 각 항목을 `severity`, `message`, `source`, `code`, 1-based line과 0-based character 위치로 변환한다. 빈 결과도 `{ diagnostics: [], counts: { error: 0, warning: 0, info: 0, hint: 0 } }`로 반환한다.

- [x] **Step 2: MCP 도구와 파일 선택 구현**

  `file`이 없으면 `currentEditor()`를 사용하고, 있으면 workspace 첫 폴더 기준 URI를 만든다. 문서나 편집기가 없으면 `isError: true`를 반환한다.

- [x] **Step 3: agent 규칙과 이벤트 표시 업데이트**

  `RULES`에 `typed:true` 뒤 `read_diagnostics`를 호출하라는 문장을 추가하고, Claude의 allowed tools 목록에 `mcp__retype__read_diagnostics`를 추가한다. 패널에는 diagnostics 호출을 확인 아이콘으로 표시한다.

- [x] **Step 4: GREEN 확인**

  Run: `npm run test:e2e`

  Expected: 교체·stale·diagnostics E2E와 기존 전체 E2E가 통과한다.

### Task 6: 회귀 테스트와 정리

**Files:**
- Modify: `src/e2e/index.ts`
- Modify: `src/ghost.ts`
- Modify: `src/server.ts`
- Modify: `src/panel.ts`

- [x] **Step 1: 기존 단위 테스트 실행**

  Run: `npm test`

  Expected: `match: 모든 검사 통과`

- [x] **Step 2: 전체 E2E 실행**

  Run: `npm run test:e2e`

  Expected: `e2e: 모든 검사 통과`

- [x] **Step 3: 컴파일 확인**

  Run: `npm run compile`

  Expected: exit code 0, TypeScript 오류 없음

- [x] **Step 4: diff와 작업 범위 확인**

  Run: `git diff --check` and `git status --short`

  Expected: whitespace 오류 없음. 변경 파일은 README, 설계 문서, 계획 문서, `src/e2e/index.ts`, `src/ghost.ts`, `src/server.ts`, `src/panel.ts` 범위다.

- [x] **Step 5: 커밋**

  ```bash
  git add docs/superpowers/specs/2026-09-14-change-proposal-verification-design.md \
    docs/superpowers/plans/2026-09-14-change-proposal-verification.md \
    src/e2e/index.ts src/ghost.ts src/server.ts src/panel.ts
  git commit -m "feat: add change proposals and diagnostics verification"
  ```
