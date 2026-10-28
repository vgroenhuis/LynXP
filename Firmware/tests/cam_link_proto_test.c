// Host test of the camera link protocol (cam_link_proto.h): a lossless, in-order byte stream in both directions
// under heavy frame corruption, and recovery when one side restarts.
//   gcc -O1 -Wall -Wextra -o /tmp/cam_link_proto_test Firmware/tests/cam_link_proto_test.c && /tmp/cam_link_proto_test
#include <stdio.h>
#include <stdlib.h>
#include "../Robot_ESP32_C5_IDF/main/cam_link_proto.h"

// Each side sends a counting byte stream (value = running count mod 251). The receiver checks that what arrives
// is contiguous (no loss, no duplicate, no reordering); after a restart of the sender one jump is allowed.
typedef struct {
    cam_link_t l; uint8_t ring[300];
    uint32_t sent;            // next value to send
    int have; uint8_t last;   // receive checker
    long tolerantUntil, now;  // after a restart the streams may glitch (in-flight bytes repeat or are lost) for a while
    long received, errors, jumps;
} side_t;

static uint8_t rnd_epoch(void) { return (uint8_t) (1 + rand() % 255); }
static void boot(side_t *s, uint32_t startValue) { cam_link_init(&s->l, rnd_epoch(), s->ring, sizeof s->ring); s->sent = startValue; }
static void feed(side_t *s, int maxN) {
    uint8_t buf[64]; int n = rand() % (maxN + 1);
    if (n > (int) cam_link_space(&s->l)) n = (int) cam_link_space(&s->l);
    for (int i = 0; i < n; i++) buf[i] = (uint8_t) (s->sent++ % 251);
    cam_link_enqueue(&s->l, buf, n);
}
static void receive(side_t *s, const uint8_t *d, int n) {
    for (int i = 0; i < n; i++) {
        uint8_t want = (uint8_t) ((s->last + 1) % 251);
        if (s->have && d[i] != want) {
            if (s->now < s->tolerantUntil) s->jumps++; else s->errors++;
        }
        s->have = 1; s->last = d[i]; s->received++;
    }
}
static void corrupt(uint8_t *f, int pct) {
    if (rand() % 100 >= pct) return;
    switch (rand() % 3) {
        case 0: f[rand() % CAM_LINK_FRAME_BYTES] ^= (uint8_t) (1 << (rand() % 8)); break;
        case 1: memset(f, 0, CAM_LINK_FRAME_BYTES); break;
        default: memset(f, 0xFF, CAM_LINK_FRAME_BYTES); break;
    }
}

static int run(int lossPct, int restartEvery, unsigned seed) {
    srand(seed);
    side_t M = {0}, S = {0};
    boot(&M, 0); boot(&S, 0);
    uint8_t mTx[CAM_LINK_FRAME_BYTES], sTx[CAM_LINK_FRAME_BYTES], a[CAM_LINK_FRAME_BYTES], b[CAM_LINK_FRAME_BYTES], out[CAM_LINK_PAYLOAD_MAX];
    cam_link_build(&S.l, sTx); // the slave's reply to the first transaction is built before it
    int restarts = 0; long afterRestart = 0, worstRecovery = 0;
    for (long step = 0; step < 100000; step++) {
        if (restartEvery && step % restartEvery == restartEvery - 1) {
            restarts++;
            if (rand() % 2) boot(&M, 100 + (uint32_t) (rand() % 100));
            else { boot(&S, 100 + (uint32_t) (rand() % 100)); cam_link_build(&S.l, sTx); }
            M.tolerantUntil = S.tolerantUntil = step + 200;
            long before = M.received + S.received; (void) before;
        }
        M.now = S.now = step;
        feed(&M, 40); feed(&S, 40);
        cam_link_build(&M.l, mTx);
        memcpy(a, mTx, sizeof a); corrupt(a, lossPct);
        memcpy(b, sTx, sizeof b); corrupt(b, lossPct);
        int n = cam_link_parse(&S.l, a, out); if (n > 0) receive(&S, out, n);
        n = cam_link_parse(&M.l, b, out);     if (n > 0) receive(&M, out, n);
        cam_link_build(&S.l, sTx);
        (void) afterRestart; (void) worstRecovery;
    }
    // liveness: both directions kept delivering
    int bad = M.errors || S.errors || M.received < 20000 || S.received < 20000;
    printf("loss %2d%% restart every %6d (seed %u): M got %ld (err %ld, jumps %ld), S got %ld (err %ld, jumps %ld), bad frames M=%u S=%u %s\n",
           lossPct, restartEvery, seed, M.received, M.errors, M.jumps, S.received, S.errors, S.jumps, M.l.framesBad, S.l.framesBad, bad ? "FAIL" : "ok");
    return bad;
}

int main(void) {
    int bad = 0;
    for (unsigned seed = 1; seed <= 4; seed++) {
        bad |= run(0, 0, seed);
        bad |= run(5, 0, seed);
        bad |= run(40, 0, seed);
        bad |= run(10, 5000, seed);
        bad |= run(0, 997, seed);
    }
    printf(bad ? "SOME TESTS FAILED\n" : "all tests passed\n");
    return bad;
}
