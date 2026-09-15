# retype Change Proposal + Verification Loop 설계

날짜: 2026-09-14
상태: 구현 승인됨

## 목표

retype의 기존 “AI가 제안하고 사람이 직접 입력한다”는 흐름을 유지하면서,
삽입만 가능한 현재 제안을 실제 수정 작업까지 확장하고, 입력 직후 현재 파일의
diagnostics를 에이전트가 읽을 수 있게 한다.

## 범위

이번 작업은 두 기능만 포함한다.

1. `propose_change` MCP 도구
   - 지정한 시작 줄부터 끝 줄까지의 기존 텍스트를 교체한다.
   - 사용자가 기존 선택 영역을 직접 지우거나, 선택된 상태에서 새 텍스트를 직접 입력해야 한다.
   - retype은 기존 텍스트를 자동으로 삭제하거나 새 텍스트를 문서에 적용하지 않는다.
   - 제안 시점의 `oldText`와 현재 문서가 다르면 `stale`로 즉시 종료한다.
   - 기존 `propose`의 삽입 동작과 결과 형식은 유지한다.

2. `read_diagnostics` MCP 도구
   - `file`을 생략하면 마지막으로 활성화된 편집기의 문서를 사용한다.
   - `file`을 넘기면 workspace 기준 파일의 diagnostics를 읽는다.
   - severity, message, source, code, 위치, severity별 개수를 JSON으로 반환한다.
   - 명령 실행, 테스트 실행, 임의 셸 접근은 이번 범위에 포함하지 않는다.

## 사용자 흐름

### 변경 제안

```
에이전트 ── propose_change(oldText, text, why) ──▶ 선택 영역 표시
                                                    │
                                      사용자가 직접 삭제/입력
                                                    ▼
                                      기존 match 규칙으로 판정
                                                    │
                         typed:true 또는 cancelled/abandoned/timeout
```

교체 범위는 1-based inclusive `startLine`과 `endLine`으로 표현한다. 각 줄의
문자열만 교체하며, 줄바꿈은 문서에 남겨 둔다. 이 제한은 열 단위 범위와 복잡한
diff 렌더링을 이번 작업에서 제외해 운영 복잡도를 낮춘다.

### 검증

```
propose/propose_change 완료
        ↓
에이전트가 read_diagnostics 호출
        ↓
오류 위치·메시지·severity 확인
        ↓
설명 후 다음 작은 제안
```

Claude의 시스템 규칙에는 `typed:true` 뒤 diagnostics를 읽으라는 지침과
`read_diagnostics` 사용법을 추가한다. Codex는 같은 규칙 문자열을 사용하므로
별도 agent 분기는 만들지 않는다.

## 구현 구조

- `src/server.ts`
  - `propose_change`의 입력 검증, 줄 범위 계산, `oldText` 일치 확인을 담당한다.
  - `read_diagnostics`의 파일 URI 해석과 diagnostics 직렬화를 담당한다.
- `src/ghost.ts`
  - 기존 `Session`에 삽입/교체 모드를 추가한다.
  - 교체 모드에서는 먼저 선택 영역을 표시하고, 첫 변경이 발생한 뒤에만 새 텍스트의 ghost를 보여준다.
  - 입력 판정과 timeout/cancel/abandon 결과는 기존 규칙을 재사용한다.
- `src/e2e/index.ts`
  - 교체, 삭제 후 입력, stale, diagnostics의 실제 VS Code/MCP 흐름을 검증한다.
- `src/panel.ts`
  - agent 규칙과 툴 이벤트 표시를 업데이트한다.
- `package.json`
  - 새 MCP 툴은 manifest에 별도 등록하지 않으므로 변경하지 않는다.

## 오류 처리

| 상황 | 결과 |
|---|---|
| `oldText`가 현재 줄 범위와 다름 | `{typed:false, reason:"stale"}` |
| 다른 파일로 이동/문서 닫힘 | `{typed:false, reason:"abandoned"}` |
| Esc | `{typed:false, reason:"cancelled"}` |
| timeout | `{typed:false, reason:"timeout"}` |
| diagnostics 대상 파일 없음 | MCP error 결과 |
| diagnostics가 없음 | 빈 목록과 0 카운트 반환 |

## 검증 기준

- 기존 `npm test`가 계속 통과한다.
- `propose_change`가 선택된 기존 텍스트를 사용자의 직접 입력으로 교체할 수 있다.
- 기존 텍스트 삭제 후 새 텍스트를 입력하는 경로가 완료된다.
- stale 범위는 입력을 시작하지 않고 종료된다.
- `read_diagnostics`가 error/warning의 위치와 메시지를 반환한다.
- 에이전트 규칙이 새 도구를 안내한다.
- 이번 작업은 파일을 자동 수정하지 않는다.

## 제외

- 열 단위 정밀 diff
- multi-file 동시 제안
- 임의 shell/test 명령 실행
- diagnostics 대시보드와 영구 통계
- 자체 채팅 UI
