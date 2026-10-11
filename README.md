# ui-review-page

화면 변경을 전후·후보끼리 나란히 놓고 항목마다 평가받는 로컬 비교 페이지입니다. 의존성 없이 Node 18+ 로 동작합니다.

[ui-feedback-loop](https://github.com/superego18/ui-feedback-loop) 스킬에서 떼어 낸 도구 부분입니다. 대화창은 [agent-chat-widget](https://github.com/superego18/agent-chat-widget)에 있습니다.

## 할 수 있는 것

- 항목마다 "좋음 / 수정 필요 / 되돌리기"와 한 줄 의견, 전체 의견, 평가 완료 표시
- 이미지 확대(맞춤·배율)와 이미지 위 핀 메모
- 2배 해상도 캡처, 캡처 때 잰 번호 상자, 캡처 근거(주소·창 크기·테마·예시 데이터 여부)
- 캡처 레시피로 다시 찍기, 찍은 조건 기록, 오래된 캡처 정리

## 구성

| 파일 | 하는 일 |
|---|---|
| `assets/review-template.html` | 비교 페이지 틀(라운드마다 데이터 블록만 바꿈) |
| `assets/review-page.js`·`review-page.css` | 비교 페이지 동작과 모양(모든 페이지가 함께 씀) |
| `scripts/review-handler.mjs` | 비교 페이지 서버의 요청 처리(다른 서버에 붙여 쓸 수 있음) |
| `scripts/review-server.mjs` | 비교 페이지 서버를 혼자 띄우기(이 컴퓨터에서만) |
| `scripts/make-capture.mjs`, `assets/capture-2x.js` | 캡처 찍기 |
| `scripts/prune-captures.mjs` | 오래된 캡처 정리 |

## 빠르게 써 보기

```bash
cp assets/review-template.html .ui-feedback/review.html   # 데이터 블록을 채운다
node scripts/review-server.mjs --dir .ui-feedback --port 4799
```

평가는 `.ui-feedback/r<라운드>.json` 에 저장됩니다. 폰에서 보거나 대화창을 함께 쓰려면 ui-feedback-loop 처럼 agent-chat-widget 과 함께 붙인 서버를 씁니다.

## 라이선스

MIT
