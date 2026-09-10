int wild() {
    int* p;
    int x = 1;
    p = &x;
    p = nullptr;
    int* q;
    (void)q;
    return x;
}

int main() {
    return wild();
}
