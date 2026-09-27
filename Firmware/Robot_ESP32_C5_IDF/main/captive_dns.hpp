#pragma once

#include <cstdint>

// Minimal captive-portal DNS responder for the setup hotspot: answers every
// A query with the hotspot's own address (and every other query type with
// an empty NOERROR), so a phone that joins the hotspot resolves its
// connectivity-check host to the robot, gets redirected to /wifi by
// web_server.cpp, and pops its "sign in to network" sheet.
//
// Idempotent; the first call starts a task that stays up for good (it's
// bound to port 53 on all interfaces, but only hotspot clients ever use the
// robot as their DNS server). answerIp is in network byte order.
void captive_dns_start(uint32_t answerIp);
