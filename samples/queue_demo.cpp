#include <queue>

int queue_demo() {
    std::queue<int> q;
    q.push(10);
    q.push(20);
    q.push(30);
    int front = q.front();
    q.pop();
    return front;
}

int main() {
    return queue_demo();
}
