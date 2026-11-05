package engine

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// unitAnswering is a unit that gives every request the same answer.
func unitAnswering(t *testing.T, status int, contentType, body string) *Unit {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if contentType != "" {
			w.Header().Set("Content-Type", contentType)
		}
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	u, err := NewUnit(srv.URL, "")
	if err != nil {
		t.Fatal(err)
	}
	return u
}

// everyCall is every call of the client, so none of them can lose an error on its own.
var everyCall = map[string]func(context.Context, *Unit) error{
	"Health":    func(c context.Context, u *Unit) error { _, err := u.Health(c); return err },
	"Operators": func(c context.Context, u *Unit) error { _, err := u.Operators(c); return err },
	"Compile":   func(c context.Context, u *Unit) error { _, err := u.Compile(c, map[string]any{}); return err },
	"Start":     func(c context.Context, u *Unit) error { _, err := u.Start(c, ExecutionStartRequest{}); return err },
	"Status":    func(c context.Context, u *Unit) error { _, err := u.Status(c, "e"); return err },
	"Cancel":    func(c context.Context, u *Unit) error { _, err := u.Cancel(c, "e"); return err },
	"Pause":     func(c context.Context, u *Unit) error { _, err := u.Pause(c, "e"); return err },
	"Resume":    func(c context.Context, u *Unit) error { _, err := u.Resume(c, "e"); return err },
	"Result": func(c context.Context, u *Unit) error {
		_, err := u.Result(c, "e", "op", "output-0", "", "", 0, 10)
		return err
	},
	"BuildEnvironment": func(c context.Context, u *Unit) error {
		_, err := u.BuildEnvironment(c, EnvironmentRequest{})
		return err
	},
	"EnvironmentStatus": func(c context.Context, u *Unit) error {
		_, err := u.EnvironmentStatus(c, "r", 1)
		return err
	},
}

func TestAnErrorAnswerKeepsItsStatusAndTheEnginesWords(t *testing.T) {
	cases := []struct {
		name, contentType, body string
		status                  int
		want                    string
	}{
		{"the contract's shape", "application/json", `{"code":"not_found","message":"no table e_1.avg"}`, 404, "no table e_1.avg"},
		{"a numeric code, as Dropwizard's own mappers answer", "application/json", `{"code":404,"message":"no table e_1.avg"}`, 404, "no table e_1.avg"},
		{"an empty message falls back to the body", "application/json", `{"code":500,"message":""}`, 500, `{"code":500,"message":""}`},
		{"JSON that names no message", "application/json", `{"oops":true}`, 500, `{"oops":true}`},
		{"a JSON array", "application/json", `["no"]`, 400, `["no"]`},
		{"a proxy's page", "text/html", "<html>Bad Gateway</html>", 502, "<html>Bad Gateway</html>"},
		{"no body at all", "", "", 503, "HTTP 503"},
		{"unicode survives", "application/json; charset=utf-8", `{"code":"invalid","message":"列 ‘花’ 不存在"}`, 400, "列 ‘花’ 不存在"},
	}
	for _, tc := range cases {
		u := unitAnswering(t, tc.status, tc.contentType, tc.body)
		for name, call := range everyCall {
			t.Run(tc.name+"/"+name, func(t *testing.T) {
				err := call(context.Background(), u)
				var refused *UnitError
				if !errors.As(err, &refused) {
					t.Fatalf("want a UnitError, got %T: %v", err, err)
				}
				if refused.Status != tc.status || refused.Message() != tc.want {
					t.Fatalf("got %d %q, want %d %q", refused.Status, refused.Message(), tc.status, tc.want)
				}
				if !strings.Contains(err.Error(), tc.want) {
					t.Fatalf("the error's text hides the words: %v", err)
				}
			})
		}
	}
}

func TestALongBodyIsBoundedButALongMessageIsNot(t *testing.T) {
	long := strings.Repeat("x", 5000)
	if got := (&UnitError{Status: 502, Body: long}).Message(); len(got) > 400 {
		t.Fatalf("a body that is not an error of ours is bounded: %d bytes", len(got))
	}
	body, _ := json.Marshal(map[string]string{"message": long})
	if got := (&UnitError{Status: 500, Body: string(body)}).Message(); got != long {
		t.Fatalf("the engine's own message stays whole: %d bytes", len(got))
	}
}

func TestASuccessIsDecoded(t *testing.T) {
	u := unitAnswering(t, 200, "application/json", `{"status":"ok","version":"2.0"}`)
	health, err := u.Health(context.Background())
	if err != nil || health.Status != "ok" {
		t.Fatalf("health: %+v %v", health, err)
	}
	// A long column keeps its exact digits, which a float64 would round.
	u = unitAnswering(t, 200, "application/json", `{"offset":0,"schema":[{"attributeName":"id","attributeType":"long"}],"rows":[[9007199254740993]]}`)
	page, err := u.Result(context.Background(), "e", "op", "output-0", "t", "n", 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	if got := page.Rows[0][0]; got != json.Number("9007199254740993") {
		t.Fatalf("exact number: %#v", got)
	}
}

func TestASuccessThatCannotBeReadIsNotAnEngineRefusal(t *testing.T) {
	u := unitAnswering(t, 200, "application/json", `{"status":`)
	_, err := u.Health(context.Background())
	var refused *UnitError
	if err == nil || errors.As(err, &refused) {
		t.Fatalf("want a decoding error, got %v", err)
	}
}

func TestAUnitThatIsDownIsNotAnEngineRefusal(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	u, err := NewUnit(srv.URL, "")
	if err != nil {
		t.Fatal(err)
	}
	srv.Close()
	_, err = u.Health(context.Background())
	var refused *UnitError
	if err == nil || errors.As(err, &refused) {
		t.Fatalf("want a connection error, got %v", err)
	}
}
